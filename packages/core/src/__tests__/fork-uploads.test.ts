import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import type { RobloxStudioTools } from '../tools/index.js';
import type { PeerTarget } from '../tools/fork-tools.js';
import { animationSourcesLuau, planUploads, soundsLuau, uploadAll, uploadsFeature, type UploadRow } from '../tools/fork/uploads.js';

type Upload = { file: string; type: string; name: string; description?: string; userId?: string; groupId?: string };
type Call = { endpoint: string; code: string; peerId: string };

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const parse = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);
const handler = uploadsFeature.handlers.upload_assets;

function wav(seconds: number, streamed = false): Buffer {
  const byteRate = 1000;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(byteRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(1, 20);
  fmt.writeUInt16LE(8, 22);
  const list = Buffer.alloc(12);
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(3, 4);
  const data = Buffer.alloc(8 + seconds * byteRate);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(streamed ? 0xffffffff : seconds * byteRate, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFFxxxxWAVE', 0, 'latin1');
  return Buffer.concat([riff, fmt, list, data]);
}

function flac(seconds: number): Buffer {
  const rate = 44100;
  const samples = rate * seconds;
  const head = Buffer.alloc(42);
  head.write('fLaC', 0, 'latin1');
  head[4] = 0x80;
  head.writeUIntBE(34, 5, 3);
  head[18] = rate >> 12;
  head[19] = (rate >> 4) & 0xff;
  head[20] = ((rate & 0x0f) << 4) | (1 << 1);
  head[21] = 0xf0 | Math.floor(samples / 2 ** 32);
  head.writeUInt32BE(samples % 2 ** 32, 22);
  return head;
}

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function folder(files: Record<string, string | number | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-uploads-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof content === 'number') {
      fs.writeFileSync(file, '');
      fs.truncateSync(file, content);
    } else {
      fs.writeFileSync(file, content);
    }
  }
  return dir;
}

function fakeTools(options: {
  upload?: (call: Upload) => Promise<unknown> | unknown;
  peers?: PeerTarget[];
  reply?: (call: Call) => unknown;
  log?: string[];
} = {}) {
  const uploads: Upload[] = [];
  const calls: Call[] = [];
  let next = 1000;
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-uploads-export-'));
  const exports: Array<{ paths: string[]; output: string }> = [];
  const tools = {
    uploadAsset: async (file: string, type: string, name: string, description?: string, userId?: string, groupId?: string) => {
      const call = { file, type, name, description, userId, groupId };
      uploads.push(call);
      options.log?.push(`upload ${path.basename(file)}`);
      return text(options.upload ? await options.upload(call) : { done: true, response: { assetId: String(next++) } });
    },
    exportRbxm: async (paths: string[], output: string) => {
      exports.push({ paths, output });
      const file = path.join(exportDir, output);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'rbxm');
      return text({ bytes_written: 4, instance_count: 1, output_path: file });
    },
    forkHost: {
      peerTargets: async (target: string) => (options.peers ?? [{ role: 'edit', peerId: 'e' }]).filter((peer) => peer.role === target),
      requestPeer: async (endpoint: string, data: unknown, peerId: string) => {
        const call = { endpoint, code: (data as { code: string }).code, peerId };
        calls.push(call);
        options.log?.push('studio');
        return options.reply ? options.reply(call) : ok({ parent: 'game.SoundService', sounds: [] });
      },
    },
  } as unknown as RobloxStudioTools;
  return { tools, uploads, calls, exports };
}

function argsOf(code: string): { parent: string; sounds: Array<{ name: string; assetId: string; class?: string }> } {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return JSON.parse(match![2]);
}

describe('upload_assets planning', () => {
  test('infers the type per extension and skips what Open Cloud would refuse', () => {
    const dir = folder({ 'a.MP3': 'x', 'b.wav': 'x', 'c.fbx': 'x', 'd.png': 'x', 'e.obj': 'x', 'f.txt': 'x', 'g.ogg': '', 'h.flac': 21 * 1024 * 1024 });
    const rows = planUploads({ files: ['a.MP3', 'b.wav', 'c.fbx', 'd.png', 'e.obj', 'f.txt', 'g.ogg', 'h.flac', 'missing.mp3'].map((name) => path.join(dir, name)) });
    const byName = Object.fromEntries(rows.map((row) => [path.basename(row.file), row]));
    expect(byName['a.MP3']).toMatchObject({ type: 'Audio', status: 'pending', name: 'a' });
    expect(byName['b.wav']).toMatchObject({ type: 'Audio', status: 'pending' });
    expect(byName['c.fbx']).toMatchObject({ type: 'Model', status: 'pending' });
    expect(byName['d.png']).toMatchObject({ type: 'Decal', status: 'pending' });
    expect(byName['e.obj']).toMatchObject({ status: 'skipped', error: expect.stringMatching(/\.obj/) });
    expect(byName['f.txt']).toMatchObject({ type: null, status: 'skipped', error: expect.stringMatching(/unsupported extension \.txt/) });
    expect(byName['g.ogg']).toMatchObject({ status: 'skipped', error: 'empty file' });
    expect(byName['h.flac']).toMatchObject({ status: 'skipped', error: expect.stringMatching(/over the 20 MB/) });
    expect(byName['missing.mp3']).toMatchObject({ status: 'skipped', error: 'file not found' });
  });

  test('directory scans are flat unless recursive, skip dotfiles, and follow asset_type', () => {
    const dir = folder({ 'hit.wav': 'x', '._hit.wav': 'x', 'logo.png': 'x', 'notes.txt': 'x', 'sub/step.ogg': 'x' });
    expect(planUploads({ directory: dir }).map((row) => path.basename(row.file))).toEqual(['hit.wav', 'logo.png']);
    expect(planUploads({ directory: dir, recursive: true, asset_type: 'Audio' }).map((row) => path.basename(row.file))).toEqual(['hit.wav', 'step.ogg']);
    expect(planUploads({ directory: dir, extensions: ['.PNG'] }).map((row) => path.basename(row.file))).toEqual(['logo.png']);
    expect(() => planUploads({ directory: dir, extensions: ['fbx'] })).toThrow(/No \.fbx files/);
    expect(() => planUploads({})).toThrow(/files or directory/);
    expect(() => planUploads({ directory: dir, asset_type: 'Video' })).toThrow(/asset_type/);
  });

  test('WAV and FLAC over 7 minutes and PNGs over 8000 pixels are skipped from their headers', () => {
    const dir = folder({
      'long.wav': wav(540), 'limit.wav': wav(420), 'stream.wav': wav(360, true),
      'long.flac': flac(500), 'short.flac': flac(60),
      'huge.png': png(9000, 100), 'edge.png': png(8000, 8000),
    });
    const byName = Object.fromEntries(planUploads({ directory: dir }).map((row) => [path.basename(row.file), row]));
    expect(byName['long.wav']).toMatchObject({ status: 'skipped', error: '540 s of audio is over the 7 minute limit' });
    expect(byName['long.flac']).toMatchObject({ status: 'skipped', error: '500 s of audio is over the 7 minute limit' });
    expect(byName['huge.png']).toMatchObject({ status: 'skipped', error: '9000x100 is over the 8000 pixel image limit' });
    for (const name of ['limit.wav', 'stream.wav', 'short.flac', 'edge.png']) expect(byName[name].status).toBe('pending');
  });

  test('asset_type rejects mismatched files, names take the prefix and stay within 50 characters', () => {
    const long = `${'x'.repeat(60)}.wav`;
    const dir = folder({ 'boom.wav': 'x', 'tree.glb': 'x', [long]: 'x' });
    const rows = planUploads({ files: ['boom.wav', 'tree.glb', long].map((name) => path.join(dir, name)), asset_type: 'Audio', name_prefix: 'SFX_' });
    expect(rows[0]).toMatchObject({ name: 'SFX_boom', status: 'pending' });
    expect(rows[1]).toMatchObject({ status: 'skipped', error: '.glb uploads as Model, not Audio' });
    expect(rows[2].name).toHaveLength(50);
  });

  test('asset_type Animation takes .rbxm and .rbxmx as animations and nothing else', () => {
    const dir = folder({ 'wave.rbxm': 'x', 'nod.rbxmx': 'x', 'icon.png': 'x', 'tree.fbx': 'x' });
    const rows = planUploads({ files: ['wave.rbxm', 'nod.rbxmx', 'icon.png'].map((name) => path.join(dir, name)), asset_type: 'Animation' });
    expect(rows[0]).toMatchObject({ type: 'Animation', status: 'pending', name: 'wave' });
    expect(rows[1]).toMatchObject({ type: 'Animation', status: 'pending' });
    expect(rows[2]).toMatchObject({ status: 'skipped', error: '.png cannot upload as Animation, only .rbxm and .rbxmx can' });
    expect(planUploads({ directory: dir, asset_type: 'Animation' }).map((row) => path.basename(row.file))).toEqual(['nod.rbxmx', 'wave.rbxm']);
    expect(planUploads({ files: [path.join(dir, 'wave.rbxm')] })[0].type).toBe('Model');
  });

  test('relative paths resolve inside the artifact folder and duplicates collapse', () => {
    const dir = folder({ 'in/a.mp3': 'x' });
    const previous = process.env.ROBLOX_MCP_ARTIFACT_DIR;
    process.env.ROBLOX_MCP_ARTIFACT_DIR = dir;
    try {
      const rows = planUploads({ files: ['in/a.mp3', path.join(dir, 'in/a.mp3')] });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ file: path.join(dir, 'in/a.mp3'), status: 'pending' });
    } finally {
      if (previous === undefined) delete process.env.ROBLOX_MCP_ARTIFACT_DIR;
      else process.env.ROBLOX_MCP_ARTIFACT_DIR = previous;
    }
  });
});

describe('upload_assets retries', () => {
  const pending = (file: string): UploadRow => ({ file, name: file, type: 'Audio', assetId: null, status: 'pending', error: null });

  test('rate limits back off and retry, other errors fail at once, timeouts and poll failures are never retried', async () => {
    const failures: Record<string, string> = {
      limited: 'Open Cloud API error (429): Too many requests',
      refused: 'Image upload failed (429): Too many requests',
      denied: 'Invalid or expired API key',
      slow: 'Asset upload timed out after 60s. Operation ID: op-1',
      slowImage: 'Image upload timed out after 60s. Operation ID: op-2',
      polled: 'Image upload status failed (429): Too many requests',
      pollLimited: 'Rate limit exceeded. Please try again later. Operation ID: op-3',
      dropped: 'Request timed out',
      stalled: 'The operation was aborted due to timeout',
    };
    const rows = ['flaky', ...Object.keys(failures)].map(pending);
    const tries: Record<string, number> = {};
    await uploadAll(rows, async (row) => {
      tries[row.file] = (tries[row.file] ?? 0) + 1;
      if (row.file === 'flaky' && tries.flaky < 3) throw new Error('Rate limit exceeded. Please try again later.');
      if (failures[row.file]) throw new Error(failures[row.file]);
      return { assetId: '42' };
    }, { concurrency: 2, backoffMs: 1 });

    const row = (file: string) => rows.find((candidate) => candidate.file === file);
    expect(row('flaky')).toMatchObject({ status: 'uploaded', assetId: '42', attempts: 3, error: null });
    expect(row('limited')).toMatchObject({ status: 'failed', attempts: 4, error: expect.stringMatching(/429/) });
    expect(row('refused')).toMatchObject({ status: 'failed', attempts: 4 });
    expect(row('denied')).toMatchObject({ status: 'failed', attempts: 1 });
    for (const file of ['slow', 'slowImage', 'polled', 'pollLimited', 'dropped', 'stalled']) {
      expect(row(file)).toMatchObject({ status: 'unconfirmed', attempts: 1, error: failures[file] });
    }
  });

  test('a decal whose image id could not be looked up says why, other rows do not', async () => {
    const rows: UploadRow[] = [
      { ...pending('found.png'), type: 'Decal' },
      { ...pending('unknown.png'), type: 'Decal' },
      pending('tone.wav'),
    ];
    await uploadAll(rows, async (row) => (row.file === 'found.png' ? { assetId: '1', imageId: '2' } : { assetId: '3' }), { concurrency: 1, backoffMs: 1 });
    expect(rows[0]).toMatchObject({ status: 'uploaded', imageId: '2' });
    expect(rows[0].imageNote).toBeUndefined();
    expect(rows[1]).toMatchObject({ status: 'uploaded', imageNote: expect.stringMatching(/Studio was not connected/) });
    expect(rows[2].imageNote).toBeUndefined();
  });

  describe('with the real client error wording', () => {
    afterEach(() => jest.restoreAllMocks());

    const outcome = async (upload: () => Promise<unknown>) => {
      const rows = [pending('x')];
      await uploadAll(rows, async () => {
        await upload();
        return { assetId: '1' };
      }, { concurrency: 1, backoffMs: 1 });
      return rows[0];
    };
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const stall = (_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    });
    const image = () => new RobloxCookieClient('cookie').uploadImage({
      fileContent: Buffer.from('png'), fileName: 'a.png', displayName: 'a', description: '', userId: '1',
    });
    const asset = () => new OpenCloudClient({ apiKey: 'key', baseUrl: 'https://cloud.invalid', timeout: 20 }).createAsset({
      assetType: 'Audio', displayName: 'a', description: '', creationContext: { creator: { userId: '1' } },
    }, Buffer.from('ogg'), 'a.ogg');

    test('a refused cookie upload is retried, a failed status poll is not', async () => {
      const refused = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => respond('slow down', 429));
      expect(await outcome(image)).toMatchObject({ status: 'failed', attempts: 4 });
      expect(refused).toHaveBeenCalledTimes(4);

      refused.mockImplementation(async (url) => (String(url).includes('/operations/')
        ? respond('slow down', 429)
        : respond({ operationId: 'op-7', done: false })));
      refused.mockClear();
      expect(await outcome(image)).toMatchObject({ status: 'unconfirmed', attempts: 1 });
      expect(refused).toHaveBeenCalledTimes(2);
    });

    test('a cookie request that hits its deadline is not retried', async () => {
      const deadline = AbortSignal.timeout.bind(AbortSignal);
      jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline(10));
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(stall);
      expect(await outcome(image)).toMatchObject({ status: 'unconfirmed', attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('an Open Cloud rate limit is retried, a timeout is not', async () => {
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => respond({ message: 'slow down' }, 429));
      expect(await outcome(asset)).toMatchObject({ status: 'failed', attempts: 4, error: expect.stringMatching(/Rate limit/) });
      expect(fetch).toHaveBeenCalledTimes(4);

      fetch.mockImplementation(stall);
      fetch.mockClear();
      expect(await outcome(asset)).toMatchObject({ status: 'unconfirmed', attempts: 1, error: 'Request timed out' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('an Open Cloud status poll that is rate limited is not retried', async () => {
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url).includes('/operations/')
        ? respond({ message: 'slow down' }, 429)
        : respond({ path: 'operations/op-9', done: false })));
      expect(await outcome(asset)).toMatchObject({ status: 'unconfirmed', attempts: 1, error: expect.stringMatching(/Operation ID: op-9/) });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  test('backoff doubles between attempts', async () => {
    const stamps: number[] = [];
    const rows = [pending('a')];
    await uploadAll(rows, async () => {
      stamps.push(Date.now());
      throw new Error('Rate limit exceeded');
    }, { concurrency: 1, backoffMs: 40 });
    const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(gaps[2]).toBeGreaterThanOrEqual(155);
  });

  test('a cancelled call leaves the rest of the batch unattempted', async () => {
    const controller = new AbortController();
    const rows = ['a', 'b', 'c'].map(pending);
    await uploadAll(rows, async () => {
      controller.abort();
      return { assetId: '1' };
    }, { concurrency: 1, backoffMs: 1, signal: controller.signal });
    expect(rows.map((row) => row.status)).toEqual(['uploaded', 'skipped', 'skipped']);
    expect(rows[1].error).toMatch(/cancelled/);
  });

  test('cancelling during a backoff stops the retries', async () => {
    const controller = new AbortController();
    const rows = [pending('a')];
    await uploadAll(rows, async () => {
      controller.abort();
      throw new Error('Rate limit exceeded');
    }, { concurrency: 1, backoffMs: 1, signal: controller.signal });
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringMatching(/cancelled before retrying/) });
  });

  test('cancelling ends a backoff that is already running', async () => {
    const controller = new AbortController();
    const rows = [pending('a')];
    const started = Date.now();
    await uploadAll(rows, async () => {
      setTimeout(() => controller.abort(), 20);
      throw new Error('Rate limit exceeded');
    }, { concurrency: 1, backoffMs: 60_000, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringMatching(/cancelled before retrying/) });
  });
});

describe('upload_assets handler', () => {
  test('animations_from exports each clip, uploads it as an Animation and creates Animations under create_in', async () => {
    const created: Array<{ name: string; assetId: string; class?: string }> = [];
    const { tools, uploads, exports } = fakeTools({
      reply: (call) => {
        if (call.code.includes('AnimationClip')) {
          return ok({
            sequences: [
              { path: 'game.ServerStorage.Rig.AnimSaves.Wave', name: 'Wave' },
              { path: 'game.ServerStorage.Rig.AnimSaves["Wave"]', name: 'Wave' },
              { path: 'game.ServerStorage.Rig.AnimSaves.Slash', name: 'Slash' },
            ],
            missing: ['game.ServerStorage.Gone'],
          });
        }
        const args = argsOf(call.code);
        created.push(...args.sounds);
        return ok({ parent: args.parent, sounds: args.sounds.map((entry) => ({ path: `${args.parent}.${entry.name}`, updated: false })) });
      },
    });
    const result = parse(await handler(tools, {
      animations_from: ['game.ServerStorage.Rig.AnimSaves', 'game.ServerStorage.Gone'],
      group_id: '9',
      name_prefix: 'Anim_',
      create_in: 'game.ReplicatedStorage.Animations',
      manifest: false,
    }));
    expect(exports.map((entry) => path.basename(entry.output))).toEqual(['Wave.rbxm', 'Wave_2.rbxm', 'Slash.rbxm']);
    expect(uploads.map((call) => [call.type, call.name, call.groupId])).toEqual([
      ['Animation', 'Anim_Wave', '9'], ['Animation', 'Anim_Wave', '9'], ['Animation', 'Anim_Slash', '9'],
    ]);
    expect(created).toEqual([
      { name: 'Wave', assetId: '1000', class: 'Animation' },
      { name: 'Wave_2', assetId: '1001', class: 'Animation' },
      { name: 'Slash', assetId: '1002', class: 'Animation' },
    ]);
    expect(result.files[0]).toMatchObject({ type: 'Animation', source: 'game.ServerStorage.Rig.AnimSaves.Wave', animation: 'game.ReplicatedStorage.Animations.Wave' });
    expect(result.missing_roots).toEqual(['game.ServerStorage.Gone']);
    expect(result.totals).toMatchObject({ files: 3, uploaded: 3 });
  });

  test('animations_from with nothing to upload fails before any upload', async () => {
    const { tools, uploads } = fakeTools({ reply: () => ok({ sequences: [], missing: ['game.Nope'] }) });
    await expect(handler(tools, { animations_from: ['game.Nope'] })).rejects.toThrow('animations_from not found: game.Nope');
    const empty = fakeTools({ reply: () => ok({ sequences: [], missing: [] }) });
    await expect(handler(empty.tools, { animations_from: ['game.ServerStorage'] })).rejects.toThrow(/No KeyframeSequence or CurveAnimation/);
    await expect(handler(empty.tools, {})).rejects.toThrow('Pass files, directory or animations_from.');
    expect(uploads).toEqual([]);
  });

  test('honours the concurrency limit and caps it at 6', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`s${index}.ogg`, 'x']));
    const dir = folder(files);
    for (const [requested, expected] of [[undefined, 3], [10, 6], [1, 1]] as const) {
      let inFlight = 0;
      let peak = 0;
      const { tools, uploads } = fakeTools({
        upload: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return { done: true, response: { assetId: '7' } };
        },
      });
      const result = parse(await handler(tools, { directory: dir, concurrency: requested, manifest: false }));
      expect(uploads).toHaveLength(12);
      expect(peak).toBe(expected);
      expect(result.totals).toEqual({ files: 12, uploaded: 12, failed: 0, skipped: 0, unconfirmed: 0 });
    }
  });

  test('passes creator, description and decal image IDs through, and one failure does not stop the batch', async () => {
    const dir = folder({ 'a.png': 'x', 'b.mp3': 'x', 'c.fbx': 'x' });
    const { tools, uploads } = fakeTools({
      upload: (call) => {
        if (call.type === 'Decal') return { done: true, response: { assetId: '11' }, decalId: '11', imageId: '12' };
        if (call.type === 'Model') return { done: true, error: { code: 3, message: 'Mesh has too many triangles' } };
        throw new Error('Open Cloud API error (400): Audio is too long');
      },
    });
    const result = parse(await handler(tools, { directory: dir, description: 'from the sound designer', group_id: '99', manifest: false }));
    expect(uploads.every((call) => call.groupId === '99' && call.description === 'from the sound designer')).toBe(true);
    const byFile = Object.fromEntries(result.files.map((row: UploadRow) => [path.basename(row.file), row]));
    expect(byFile['a.png']).toMatchObject({ status: 'uploaded', assetId: '11', imageId: '12', type: 'Decal' });
    expect(byFile['b.mp3']).toMatchObject({ status: 'failed', error: expect.stringMatching(/too long/) });
    expect(byFile['c.fbx']).toMatchObject({ status: 'failed', error: 'Asset upload failed: Mesh has too many triangles' });
    expect(result.totals).toMatchObject({ uploaded: 1, failed: 2 });
  });

  test('create_in is checked before uploading and then gets one Sound per uploaded audio file', async () => {
    const dir = folder({ 'hit.wav': 'x', 'hit.ogg': 'x', 'sub/hit.mp3': 'x', 'logo.png': 'x', 'bad.flac': 'x' });
    const log: string[] = [];
    const { tools, calls } = fakeTools({
      log,
      upload: (call) => {
        if (call.file.endsWith('bad.flac')) throw new Error('Open Cloud API error (400): invalid audio');
        return { done: true, response: { assetId: String(100 + log.length) } };
      },
      reply: (call) => {
        const args = argsOf(call.code);
        return ok({
          parent: 'game.SoundService.SFX',
          sounds: args.sounds.map((sound, index) => ({ path: `game.SoundService.SFX.${sound.name}`, updated: index === 0 })),
          undoable: true,
        });
      },
    });
    const result = parse(await handler(tools, { directory: dir, recursive: true, create_in: 'game.SoundService.SFX', concurrency: 1, manifest: false, instance_id: 'inst' }));

    expect(log[0]).toBe('studio');
    expect(log[log.length - 1]).toBe('studio');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.endpoint === '/api/execute-luau' && call.peerId === 'e')).toBe(true);
    expect(argsOf(calls[0].code)).toEqual({ parent: 'game.SoundService.SFX', sounds: [] });
    const placed = argsOf(calls[1].code).sounds;
    expect(placed.map((sound) => sound.name)).toEqual(['hit', 'hit_2', 'hit_3']);
    expect(placed.every((sound) => /^\d+$/.test(sound.assetId))).toBe(true);
    expect(calls[1].code).toContain('MCP: upload_assets');
    expect(result.sounds).toEqual({ parent: 'game.SoundService.SFX', created: 2, updated: 1, undoable: true });
    const hit = result.files.find((row: UploadRow) => row.file.endsWith('hit.ogg'));
    expect(hit.sound).toBe('game.SoundService.SFX.hit');
    expect(result.files.find((row: UploadRow) => row.file.endsWith('logo.png')).sound).toBeUndefined();
  });

  test('Sound names never collide with a real stem and do not depend on which uploads failed', async () => {
    const dir = folder({ 'hit.wav': 'x', 'hit.ogg': 'x', 'hit_2.wav': 'x' });
    const placedNames = async (failing?: string) => {
      const { tools, calls } = fakeTools({
        upload: (call) => {
          if (path.basename(call.file) === failing) throw new Error('Open Cloud API error (400): invalid audio');
          return { done: true, response: { assetId: path.basename(call.file) } };
        },
      });
      await handler(tools, { directory: dir, create_in: 'game.SoundService', manifest: false });
      return Object.fromEntries(argsOf(calls[1].code).sounds.map((sound) => [sound.assetId, sound.name]));
    };

    const all = await placedNames();
    expect(all['hit_2.wav']).toBe('hit_2');
    expect(new Set(Object.values(all)).size).toBe(3);
    const bare = Object.keys(all).find((file) => all[file] === 'hit')!;
    const partial = await placedNames(bare);
    expect(partial).toEqual(Object.fromEntries(Object.entries(all).filter(([file]) => file !== bare)));
  });

  test('a cancelled call adds no Sounds but still reports the uploads that finished', async () => {
    const dir = folder({ 'a.mp3': 'x', 'b.mp3': 'x' });
    const controller = new AbortController();
    const { tools, calls } = fakeTools({
      upload: () => {
        controller.abort();
        return { done: true, response: { assetId: '5' } };
      },
    });
    const result = parse(await handler(tools, { directory: dir, create_in: 'game.SoundService', concurrency: 1, manifest: false }, { signal: controller.signal }));
    expect(calls).toHaveLength(1);
    expect(result.sounds).toEqual({ created: 0, note: 'Cancelled, so no Sounds were added.' });
    expect(result.totals).toMatchObject({ uploaded: 1, skipped: 1 });
  });

  test('a missing create_in path fails before any upload', async () => {
    const dir = folder({ 'a.mp3': 'x' });
    const { tools, uploads } = fakeTools({ reply: () => ok({ error: 'create_in not found: game.Nope' }) });
    await expect(handler(tools, { directory: dir, create_in: 'game.Nope', manifest: false })).rejects.toThrow(/create_in not found/);
    expect(uploads).toHaveLength(0);

    const none = fakeTools({ peers: [] });
    await expect(handler(none.tools, { directory: dir, create_in: 'game.SoundService', manifest: false })).rejects.toThrow(/one edit peer/);
    expect(none.uploads).toHaveLength(0);
  });

  test('create_in without any audio leaves Studio alone and says so', async () => {
    const dir = folder({ 'logo.png': 'x' });
    const { tools, calls } = fakeTools();
    const result = parse(await handler(tools, { directory: dir, create_in: 'game.SoundService', manifest: false }));
    expect(calls).toHaveLength(0);
    expect(result.sounds).toMatchObject({ created: 0, note: expect.stringMatching(/No audio/) });
  });

  test('a Studio failure after uploading keeps the asset IDs', async () => {
    const dir = folder({ 'a.mp3': 'x' });
    let call = 0;
    const { tools } = fakeTools({ reply: () => (call++ === 0 ? ok({ parent: 'game.SoundService', sounds: [] }) : { success: false, error: 'peer gone' }) });
    const result = parse(await handler(tools, { directory: dir, create_in: 'game.SoundService', manifest: false }));
    expect(result.totals.uploaded).toBe(1);
    expect(result.files[0].assetId).toBe('1000');
    expect(result.sounds.error).toMatch(/peer gone/);
  });

  test('writes the manifest into the artifact folder', async () => {
    const dir = folder({ 'drop/a.mp3': 'x', 'drop/b.obj': 'x' });
    const previous = process.env.ROBLOX_MCP_ARTIFACT_DIR;
    process.env.ROBLOX_MCP_ARTIFACT_DIR = dir;
    try {
      const { tools } = fakeTools();
      const result = parse(await handler(tools, { files: ['drop/a.mp3', 'drop/b.obj'] }));
      expect(path.dirname(result.manifest)).toBe(path.join(dir, 'uploads'));
      expect(path.basename(result.manifest)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
      const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
      expect(manifest.totals).toEqual({ files: 2, uploaded: 1, failed: 0, skipped: 1, unconfirmed: 0 });
      expect(manifest.files[0]).toMatchObject({ file: path.join(dir, 'drop/a.mp3'), name: 'a', type: 'Audio', assetId: '1000', status: 'uploaded', error: null });
      expect(manifest.files[1]).toMatchObject({ name: 'b', type: null, assetId: null, status: 'skipped' });
      for (const row of manifest.files) expect(Object.keys(row)).toEqual(expect.arrayContaining(['file', 'name', 'type', 'assetId', 'status', 'error']));
    } finally {
      if (previous === undefined) delete process.env.ROBLOX_MCP_ARTIFACT_DIR;
      else process.env.ROBLOX_MCP_ARTIFACT_DIR = previous;
    }
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const SNIPPETS: Record<string, string> = {
  soundsCheck: soundsLuau({ parent: 'game.SoundService', sounds: [] }),
  soundsPlace: soundsLuau({ parent: 'game.SoundService["SFX ]]"]', sounds: [{ name: 'hit', assetId: '123' }, { name: 'hit_2', assetId: '456' }] }),
  animationsPlace: soundsLuau({ parent: 'game.ReplicatedStorage.Animations', sounds: [{ name: 'Wave', assetId: '789', class: 'Animation' }] }),
  animationSources: animationSourcesLuau({ roots: ['game.ServerStorage.Rig.AnimSaves'] }),
};

describe('upload_assets Luau', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-uploads-luau-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

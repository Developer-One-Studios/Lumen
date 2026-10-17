import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicToolDefinition } from '../mcp-runtime.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { captureFeature } from '../tools/fork/capture.js';
import { captureStaged, DEFAULT_STAGE_AT, frameView, parseStage, stageViews } from '../tools/fork/capture-stage.js';
import { stageLuau, unstageLuau, type StagedCopy } from '../tools/fork/capture-stage-luau.js';

type Call = { endpoint: string; data: Record<string, unknown>; peerId: string };

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return match ? JSON.parse(match[2]) : {};
}

function fakeHost(peers: PeerTarget[], reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const host: ForkHost = {
    peerTargets: async () => peers,
    requestPeer: async (endpoint, data, peerId) => {
      const call = { endpoint, data: data as Record<string, unknown>, peerId };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls };
}

const COPY: StagedCopy = { index: 1, path: 'game.ReplicatedStorage.Units.Gojo', center: [10, 2, 0], size: [4, 4, 2], front: [0, 0, -1] };
const close = (actual: number[], expected: number[]) => actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 2));

describe('stage arguments', () => {
  test('parses paths with defaults and refuses bad ones', () => {
    expect(parseStage({ paths: ['game.Workspace.A'] })).toEqual({ paths: ['game.Workspace.A'], at: DEFAULT_STAGE_AT, settle_s: 1 });
    expect(parseStage({ paths: ['a', 'b'], at: [1, 2, 3], settle_s: 0 })).toEqual({ paths: ['a', 'b'], at: [1, 2, 3], settle_s: 0 });
    expect(() => parseStage(['a'])).toThrow(/stage must be an object/);
    expect(() => parseStage({ paths: [] })).toThrow(/1 to 8 instance paths/);
    expect(() => parseStage({ paths: Array(9).fill('a') })).toThrow(/1 to 8 instance paths/);
    expect(() => parseStage({ paths: ['a'], at: [1, 2] })).toThrow(/stage.at must be three finite numbers/);
    expect(() => parseStage({ paths: ['a'], settle_s: 9 })).toThrow(/settle_s must be from 0 to 5/);
  });

  test('framed views need a stage, a copy that exists and no camera of their own', () => {
    expect(stageViews([{ camera_position: [0, 0, 0] }, { frame: 0, yaw: 90, label: 'side' }], 2)).toEqual([
      { camera_position: [0, 0, 0] },
      { frame: 0, yaw: 90, pitch: undefined, label: 'side' },
    ]);
    expect(() => stageViews([{ frame: 1 }], undefined)).toThrow(/pass stage with it/);
    expect(() => stageViews([{ frame: 3 }], 2)).toThrow(/1 to 2 for one of them/);
    expect(() => stageViews([{ frame: 1.5 }], 2)).toThrow(/must be 0 for every staged copy/);
    expect(() => stageViews([{ frame: 1, look_at: [0, 0, 0] }], 2)).toThrow(/leave camera_position and look_at out/);
  });
});

describe('frameView', () => {
  test('stands in front of the copy, slightly above, far enough to fit it', () => {
    const view = frameView({ frame: 1 }, [COPY], 70, 16 / 9);
    expect(view.look_at).toEqual([10, 2, 0]);
    expect(view.label).toBe('stage-1');
    const offset = view.camera_position.map((value, axis) => value - view.look_at[axis]);
    const distance = Math.hypot(...offset);
    // Front is -Z, so the camera stands on the -Z side, and 15 degrees up.
    close(offset.map((value) => value / distance), [0, Math.sin(Math.PI / 12), -Math.cos(Math.PI / 12)]);
    const radius = Math.hypot(4, 4, 2) / 2;
    expect(distance).toBeCloseTo((radius / Math.sin((70 * Math.PI) / 360)) * 1.05, 3);
  });

  test('yaw 90 shows the left side and frame 0 frames every copy', () => {
    const left = frameView({ frame: 1, yaw: 90, pitch: 0 }, [COPY], 70, 16 / 9);
    expect(left.label).toBe('stage-1 yaw 90');
    const offset = left.camera_position.map((value, axis) => value - left.look_at[axis]);
    close(offset.map((value) => value / Math.hypot(...offset)), [-1, 0, 0]);

    const other: StagedCopy = { ...COPY, index: 2, center: [20, 2, 0] };
    const all = frameView({ frame: 0 }, [COPY, other], 70, 16 / 9);
    expect(all.look_at).toEqual([15, 2, 0]);
    expect(all.label).toBe('stage');
  });

  test('a narrow viewport backs the camera off further', () => {
    const wide = frameView({ frame: 1 }, [COPY], 70, 16 / 9);
    const narrow = frameView({ frame: 1 }, [COPY], 70, 0.5);
    const distance = (view: { camera_position: number[]; look_at: number[] }) =>
      Math.hypot(...view.camera_position.map((value, axis) => value - view.look_at[axis]));
    expect(distance(narrow)).toBeGreaterThan(distance(wide));
  });
});

describe('captureStaged', () => {
  const staged = { staged: [COPY], recorded: true, fov: 70, aspect: 16 / 9 };
  const image = { content: [{ type: 'text', text: JSON.stringify({ images: [{ image: 1, label: 'stage-1' }] }) }, { type: 'image', data: 'x', mimeType: 'image/jpeg' }] };

  test('stages, shoots framed views, takes the copies out and reports them', async () => {
    const { host, calls } = fakeHost([{ role: 'edit', peerId: 'p-edit' }], (call) =>
      ok(String(call.data.code).includes('openRecording("capture_views stage")') ? staged : { removed: true, cancelled: true, left: false }));
    const capture = jest.fn(async () => image);
    const result = await captureStaged(host, {
      stage: { paths: ['game.ReplicatedStorage.Units.Gojo'] },
      views: [{ frame: 1 }, { camera_position: [1, 2, 3], label: 'own' }],
    }, capture);

    expect(calls.map((call) => call.peerId)).toEqual(['p-edit', 'p-edit']);
    expect(args(calls[0].data.code as string)).toEqual({ paths: ['game.ReplicatedStorage.Units.Gojo'], at: DEFAULT_STAGE_AT, settle_s: 1 });
    expect(calls[1].data.code).toContain('clearStage()');
    const views = (capture.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0];
    expect(views[0]).toMatchObject({ look_at: [10, 2, 0], label: 'stage-1' });
    expect(views[1]).toEqual({ camera_position: [1, 2, 3], label: 'own' });
    expect(JSON.parse(result.content[0].text!)).toEqual({
      images: [{ image: 1, label: 'stage-1' }],
      stage: [{ index: 1, path: COPY.path, center: COPY.center, size: COPY.size }],
    });
    expect(result.content[1]).toEqual(image.content[1]);
  });

  test('takes the copies out when the capture fails, and says so when they stay', async () => {
    const { host, calls } = fakeHost([{ role: 'edit', peerId: 'p-edit' }], (call) =>
      ok(String(call.data.code).includes('openRecording("capture_views stage")') ? staged : { removed: true, cancelled: false, left: true }));
    await expect(captureStaged(host, { stage: { paths: ['a'] }, views: [{ frame: 1 }] }, async () => {
      throw new Error('shot failed');
    })).rejects.toThrow(/shot failed \(the staged copies are still in Workspace.__LumenStage/);
    expect(calls).toHaveLength(2);
  });

  test('refuses a running playtest and clients before staging anything', async () => {
    const playing = fakeHost([{ role: 'edit', peerId: 'e' }, { role: 'client-1', peerId: 'c' }], () => ok({}));
    await expect(captureStaged(playing.host, { stage: { paths: ['a'] }, views: [{ frame: 1 }] }, async () => image))
      .rejects.toThrow(/stop the playtest first/);
    expect(playing.calls).toHaveLength(0);
    const edit = fakeHost([{ role: 'edit', peerId: 'e' }], () => ok({}));
    await expect(captureStaged(edit.host, { stage: { paths: ['a'] }, views: [{ frame: 1 }], clients: 'all' }, async () => image))
      .rejects.toThrow(/leave clients out/);
    expect(edit.calls).toHaveLength(0);
  });
});

describe('capture_views stage wiring', () => {
  test('a framed view without stage is refused, and the definition stays in budget', async () => {
    const tools = { captureScreenshot: jest.fn(), fork: { serializeCapture: (run: () => Promise<unknown>) => run() } } as never;
    await expect(captureFeature.handlers.capture_views(tools, { views: [{ frame: 1 }] })).rejects.toThrow(/pass stage with it/);
    const definition = captureFeature.definitions.find((tool) => tool.name === 'capture_views')!;
    expect(definition.description!.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(publicToolDefinition(definition)).length).toBeLessThanOrEqual(2600);
    expect(captureFeature.guide).not.toMatch(/[—–;]/);
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const SNIPPETS: Record<string, string> = {
  stage: stageLuau({ paths: ['game.ReplicatedStorage.Units.Gojo'], at: DEFAULT_STAGE_AT, settle_s: 1 }),
  unstage: unstageLuau(),
};

describe('stage Luau snippets', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-stage-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });

  test('the stage is never saved and is cancelled out of undo history', () => {
    expect(SNIPPETS.stage).toContain('folder.Archivable = false');
    expect(SNIPPETS.stage).toContain('ContentProvider.PreloadAsync, ContentProvider, { folder }');
    expect(SNIPPETS.stage.indexOf('openRecording(')).toBeLessThan(SNIPPETS.stage.indexOf('folder.Parent = Workspace'));
    expect(SNIPPETS.unstage).toContain('closeRecording(held.recording, false)');
  });
});

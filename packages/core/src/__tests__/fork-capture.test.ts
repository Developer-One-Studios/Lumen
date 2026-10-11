import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { decodePngBase64ToRgba } from '../image-decode.js';
import { downscaleRgba, fitWidth } from '../image-resize.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { getReadOnlyTools, TOOL_DEFINITIONS } from '../tools/definitions.js';
import { captureFeature } from '../tools/fork/capture.js';
import { cameraRestoreLuau, cameraSetLuau, clientCameraRestoreLuau, clientCameraSetLuau } from '../tools/fork-luau.js';
import { ForkTools, cameraViews, type ForkHost, type PeerTarget } from '../tools/fork-tools.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

const SNIPPETS: Record<string, string> = {
  cameraSet: cameraSetLuau({ position: [0, 10, 0], look_at: [0, 0, 0] }),
  cameraRestore: cameraRestoreLuau({ saved: { cframe: IDENTITY, focus: IDENTITY } }),
  cameraRestoreFromStash: cameraRestoreLuau({}),
  clientCameraSet: clientCameraSetLuau({ position: [0, 10, 0], look_at: [0, 0, 0] }),
  clientCameraSetNoTarget: clientCameraSetLuau({ position: [0, 10, 0] }),
  clientCameraRestore: clientCameraRestoreLuau({ saved: { cframe: IDENTITY, focus: IDENTITY, camera_type: 'Custom' } }),
  clientCameraRestoreFromStash: clientCameraRestoreLuau({}),
};

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[=*\[\n(.*?)\]=*\]\)/s.exec(code);
  return match ? JSON.parse(match[1]) : {};
}

function cameraCall(code: string): 'set' | 'restore' | undefined {
  if (code.includes('CFrame.lookAt(position, target)')) return 'set';
  if (code.includes('restored = true')) return 'restore';
  return undefined;
}

const isClientSnippet = (code: string) => code.includes('RenderStep');

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });

function frame(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, rgba };
}

// The baseline SOF0 header holds the height and then the width.
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  const at = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
}

describe('image resize', () => {
  test('fits a width while keeping the aspect ratio', () => {
    expect(fitWidth(1920, 1080, 960)).toEqual({ width: 960, height: 540 });
    expect(fitWidth(1366, 768, 1000)).toEqual({ width: 1000, height: 562 });
    expect(fitWidth(800, 600, 1000)).toEqual({ width: 800, height: 600 });
    expect(fitWidth(1000, 3, 64)).toEqual({ width: 64, height: 1 });
  });

  test('averages every 2x2 block on an even halving', () => {
    const source = frame(4, 2, (x, y) => [x * 40 + y * 10, 200 - x * 20, y * 100, 255]);
    const out = downscaleRgba(source, 2, 1);
    expect([out.width, out.height]).toEqual([2, 1]);
    // Block 0 holds x 0..1 and y 0..1: red (0+40+10+50)/4, green (200+180+200+180)/4, blue (0+0+100+100)/4.
    expect([...out.rgba]).toEqual([25, 190, 50, 255, 105, 150, 50, 255]);
  });

  test('weights partly covered source pixels by the fraction covered', () => {
    const out = downscaleRgba(frame(3, 1, (x) => [x * 90, 0, 0, 255]), 2, 1);
    // Output 0 covers [0, 1.5): 0 * 2/3 + 90 * 1/3. Output 1 covers [1.5, 3): 90 * 1/3 + 180 * 2/3.
    expect([out.rgba[0], out.rgba[4]]).toEqual([30, 150]);
  });

  test('keeps a flat colour flat and averages fine detail instead of dropping it', () => {
    const flat = downscaleRgba(frame(7, 5, () => [77, 133, 9, 255]), 3, 2);
    for (let i = 0; i < flat.rgba.length; i += 4) expect([...flat.rgba.subarray(i, i + 4)]).toEqual([77, 133, 9, 255]);

    // Nearest sampling turns a one pixel checkerboard into a solid colour, averaging gives mid grey.
    const checker = downscaleRgba(frame(8, 8, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 4, 4);
    for (let i = 0; i < checker.rgba.length; i += 4) expect(checker.rgba[i]).toBe(128);
  });

  test('returns the same frame at the same size and refuses upscaling or a short buffer', () => {
    const source = frame(2, 2, () => [1, 2, 3, 255]);
    expect(downscaleRgba(source, 2, 2)).toBe(source);
    expect(() => downscaleRgba(source, 3, 2)).toThrow(/cannot downscale/);
    expect(() => downscaleRgba({ width: 2, height: 2, rgba: Buffer.alloc(8) }, 1, 1)).toThrow(/expected 16/);
  });
});

describe('camera views', () => {
  test('parses placements with optional look_at and label', () => {
    expect(cameraViews([{ camera_position: [1, 2, 3], label: 'front' }, { camera_position: [4, 5, 6], look_at: [0, 1, 0] }]))
      .toEqual([{ position: [1, 2, 3], label: 'front' }, { position: [4, 5, 6], look_at: [0, 1, 0] }]);
    expect(cameraViews([{ camera_position: [0, 0, 0], label: 'x'.repeat(150) }])[0].label).toHaveLength(100);
  });

  test('rejects malformed placements', () => {
    expect(() => cameraViews(undefined)).toThrow(/1 to 8/);
    expect(() => cameraViews([])).toThrow(/1 to 8/);
    expect(() => cameraViews(Array.from({ length: 9 }, () => ({ camera_position: [0, 0, 0] })))).toThrow(/1 to 8/);
    expect(() => cameraViews([[0, 0, 0]])).toThrow('views[0] must be an object');
    expect(() => cameraViews([{ camera_position: [1, 2] }])).toThrow('views[0].camera_position must be [x, y, z]');
    expect(() => cameraViews([{ camera_position: [0, 0, Infinity] }])).toThrow('views[0].camera_position must be [x, y, z]');
    expect(() => cameraViews([{ camera_position: [1, 2, 3], look_at: [1, 'a', 3] }])).toThrow('views[0].look_at must be [x, y, z]');
    expect(() => cameraViews([{ camera_position: [1, 2, 3] }, { camera_position: [1, 2, 3], look_at: [1, 2, 3] }]))
      .toThrow(/views\[1\]\.look_at must differ/);
    expect(() => cameraViews([{ camera_position: [0, 0, 0], label: 7 }])).toThrow('views[0].label must be a string');
  });
});

describe('camera moves around captures', () => {
  type Failure = 'refused' | 'lost';
  type Camera = { at: string; type: string; bound: boolean; stash?: { at: string; type: string } };

  // One camera per peer that mirrors the snippets: set stashes the first camera it finds, restore prefers that stash.
  function cameraHost(peers: PeerTarget[]) {
    const cameras = new Map<string, Camera>(peers.map((peer) => [peer.peerId, { at: 'user-view', type: 'Custom', bound: false }]));
    const log: string[] = [];
    const restoreCodes: string[] = [];
    const setFailures = new Map<number, Failure>();
    const drift = new Set<number>();
    let failRestores = 0;
    let sets = 0;
    const host: ForkHost = {
      peerTargets: async (target) => peers.filter((peer) => target === undefined || target === 'all' || peer.role === target),
      requestPeer: async (_endpoint, data, peerId) => {
        const code = (data as { code: string }).code;
        const camera = cameras.get(peerId)!;
        const parsed = args(code);
        const client = isClientSnippet(code);
        if (cameraCall(code) === 'set') {
          const index = sets++;
          const failure = setFailures.get(index);
          if (failure === 'refused') return { success: false, error: 'set refused' };
          camera.stash ??= { at: camera.at, type: camera.type };
          camera.at = `at:${(parsed.position as number[]).join(',')}`;
          if (client) {
            camera.type = 'Scriptable';
            camera.bound = true;
          }
          log.push(`${peerId} ${client ? 'client-set' : 'edit-set'} ${camera.at}`);
          if (failure === 'lost') throw new Error('timed out waiting for Studio');
          const saved = { cframe: [camera.stash.at], focus: [camera.stash.at], ...(client ? { camera_type: camera.stash.type } : {}) };
          return ok({ saved, held: !drift.has(index) });
        }
        if (cameraCall(code) === 'restore') {
          restoreCodes.push(code);
          if (failRestores > 0) {
            failRestores--;
            log.push(`${peerId} restore failed`);
            return { success: false, error: 'restore failed' };
          }
          const given = parsed.saved as { cframe: string[]; camera_type?: string } | undefined;
          const saved = camera.stash ? { cframe: [camera.stash.at], camera_type: client ? camera.stash.type : undefined } : given;
          camera.stash = undefined;
          if (client) camera.bound = false;
          if (saved === undefined) {
            log.push(`${peerId} restore nothing`);
            return ok({ restored: false });
          }
          camera.at = saved.cframe[0];
          if (saved.camera_type !== undefined) camera.type = saved.camera_type;
          log.push(`${peerId} restore ${camera.at} ${saved.camera_type ?? ''}`.trim());
          return ok({ restored: true });
        }
        return ok({});
      },
      soloPlaytest: async () => ({ content: [] }),
      getRuntimeLogs: async () => ({ content: [] }),
    };
    return {
      host,
      cameras,
      log,
      restoreCodes,
      failSet: (index: number, failure: Failure) => setFailures.set(index, failure),
      driftAt: (index: number) => drift.add(index),
      failNextRestore: () => { failRestores++; },
    };
  }

  const views = [{ position: [0, 50, 0], label: 'top' }, { position: [30, 5, 0], look_at: [0, 0, 0] }, { position: [0, 5, 30] }];
  const edit = { role: 'edit', peerId: 'e' };
  const client = { role: 'client-2', peerId: 'c2' };

  test('shoots every view in order and restores the user camera once', async () => {
    const { host, cameras, log } = cameraHost([edit]);
    const shots: string[] = [];
    const result = await new ForkTools(host).withCameraViews(edit, views, async (index, held) => {
      shots.push(`${index}:${cameras.get('e')!.at}:${held}`);
      return index;
    });
    expect(result).toEqual({ results: [0, 1, 2], restoreError: undefined });
    expect(shots).toEqual(['0:at:0,50,0:true', '1:at:30,5,0:true', '2:at:0,5,30:true']);
    expect(log).toEqual(['e edit-set at:0,50,0', 'e edit-set at:30,5,0', 'e edit-set at:0,5,30', 'e restore user-view']);
    expect(cameras.get('e')).toMatchObject({ at: 'user-view', type: 'Custom' });
  });

  test('takes over a playtest client camera and hands it back with its camera type', async () => {
    const { host, cameras, log, restoreCodes } = cameraHost([edit, client]);
    const states: string[] = [];
    await new ForkTools(host).withCameraViews(client, views.slice(0, 2), async () => {
      states.push(`${cameras.get('c2')!.type} bound=${cameras.get('c2')!.bound}`);
    });
    expect(states).toEqual(['Scriptable bound=true', 'Scriptable bound=true']);
    expect(log).toEqual(['c2 client-set at:0,50,0', 'c2 client-set at:30,5,0', 'c2 restore user-view Custom']);
    expect(cameras.get('c2')).toEqual({ at: 'user-view', type: 'Custom', bound: false });
    expect(cameras.get('e')).toMatchObject({ at: 'user-view', type: 'Custom' });
    expect(restoreCodes).toHaveLength(1);
    expect(restoreCodes[0]).toContain('UnbindFromRenderStep');
    expect(args(restoreCodes[0]).saved).toEqual({ cframe: ['user-view'], focus: ['user-view'], camera_type: 'Custom' });
  });

  test('tells the capture when the camera drifted off a view', async () => {
    const { host, driftAt } = cameraHost([client]);
    driftAt(1);
    const held: boolean[] = [];
    await new ForkTools(host).withCameraViews(client, views, async (_index, stayed) => { held.push(stayed); });
    expect(held).toEqual([true, false, true]);
  });

  test('restores the user camera when a capture or a later move fails', async () => {
    const failing = cameraHost([edit]);
    await expect(new ForkTools(failing.host).withCameraViews(edit, views, async (index) => {
      if (index === 1) throw new Error('capture boom');
    })).rejects.toThrow('capture boom');
    expect(failing.log.filter((line) => line.includes('restore'))).toEqual(['e restore user-view']);

    const moving = cameraHost([edit]);
    moving.failSet(1, 'refused');
    await expect(new ForkTools(moving.host).withCameraViews(edit, views, async () => undefined)).rejects.toThrow('set refused');
    expect(moving.log).toEqual(['e edit-set at:0,50,0', 'e restore user-view']);
    expect(moving.cameras.get('e')!.at).toBe('user-view');
  });

  test('a first client move whose reply is lost is still undone from the stash', async () => {
    const { host, cameras, log, restoreCodes, failSet } = cameraHost([client]);
    failSet(0, 'lost');
    await expect(new ForkTools(host).withCameraViews(client, views, async () => undefined)).rejects.toThrow('timed out');
    expect(log).toEqual(['c2 client-set at:0,50,0', 'c2 restore user-view Custom']);
    expect(args(restoreCodes[0]).saved).toBeUndefined();
    expect(cameras.get('c2')).toEqual({ at: 'user-view', type: 'Custom', bound: false });
  });

  test('a first move refused before it moved sends a restore that finds nothing to undo', async () => {
    const { host, cameras, log, failSet } = cameraHost([edit]);
    failSet(0, 'refused');
    await expect(new ForkTools(host).withCameraViews(edit, views, async () => undefined)).rejects.toThrow('set refused');
    expect(log).toEqual(['e restore nothing']);
    expect(cameras.get('e')!.at).toBe('user-view');
  });

  test('a failed restore is reported, and the next call still restores the camera saved first', async () => {
    const { host, cameras, log, failNextRestore } = cameraHost([client]);
    const tools = new ForkTools(host);
    failNextRestore();
    const first = await tools.withCameraViews(client, views.slice(0, 1), async () => undefined);
    expect(first.restoreError).toBe('restore failed');
    expect(cameras.get('c2')).toMatchObject({ at: 'at:0,50,0', type: 'Scriptable' });

    await tools.withCameraViews(client, views.slice(1, 2), async () => undefined);
    expect(log.slice(-2)).toEqual(['c2 client-set at:30,5,0', 'c2 restore user-view Custom']);
    expect(cameras.get('c2')).toEqual({ at: 'user-view', type: 'Custom', bound: false });
  });

  test('overlapping serialized captures each restore the real view, never another call\'s temporary camera', async () => {
    const { host, cameras } = cameraHost([edit]);
    const tools = new ForkTools(host);
    const shots: string[] = [];
    const shoot = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      shots.push(cameras.get('e')!.at);
    };
    await Promise.all([
      tools.serializeCapture(() => tools.withCameraViews(edit, [{ position: [0, 60, 10] }], shoot)),
      tools.serializeCapture(() => tools.withCameraViews(edit, [{ position: [42, 6, 42] }], shoot)),
      tools.serializeCapture(shoot),
    ]);
    expect(shots).toEqual(['at:0,60,10', 'at:42,6,42', 'user-view']);
    expect(cameras.get('e')!.at).toBe('user-view');
  });
});

describe('capture_screenshot and capture_views through Studio routing', () => {
  let lastTools: RobloxStudioTools | undefined;
  const hostCapture = process.env.ROBLOX_STUDIO_HOST_CAPTURE;
  beforeEach(() => {
    // Synthetic topology only. Never inspect the user's managed Studio state or grab real windows.
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    process.env.ROBLOX_STUDIO_HOST_CAPTURE = '0';
  });
  afterEach(async () => {
    await lastTools?.dispose();
    lastTools = undefined;
    jest.restoreAllMocks();
    if (hostCapture === undefined) delete process.env.ROBLOX_STUDIO_HOST_CAPTURE;
    else process.env.ROBLOX_STUDIO_HOST_CAPTURE = hostCapture;
  });

  function register(bridge: BridgeService, instanceId: string, role: string, group?: string) {
    const peerId = `peer:${instanceId}:${role}`;
    const result = bridge.registerPeer({
      peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId: group,
      placeId: 123, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
    });
    if (!result.ok) throw new Error(result.error.message);
    return peerId;
  }

  // Not a flat frame, so the host window fallback stays out of the way.
  const gradient = (width: number, height: number) => frame(width, height, (x, y) => [x % 256, (y * 7) % 256, 50, 255]);

  type Fake = { failCapture?: string; failRestore?: string; drift?: number[] };

  function setup(bridge: BridgeService, capture = gradient(4, 2), fake: Fake = {}) {
    const calls: string[] = [];
    let sets = 0;
    const request = jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation(async (endpoint, data, peerId) => {
      const code = (data as { code?: string } | undefined)?.code ?? '';
      const kind = cameraCall(code);
      const client = isClientSnippet(code);
      if (kind === 'set') {
        calls.push(`${peerId} ${client ? 'client-set' : 'edit-set'} ${(args(code).position as number[]).join(',')}`);
        const saved = { cframe: [1, 2, 3, ...IDENTITY.slice(3)], focus: IDENTITY, ...(client ? { camera_type: 'Custom' } : {}) };
        return ok({ saved, held: !(fake.drift ?? []).includes(sets++) });
      }
      if (kind === 'restore') {
        const saved = args(code).saved as { cframe: number[]; camera_type?: string };
        calls.push(`${peerId} ${client ? 'client-restore' : 'edit-restore'} ${saved.cframe.slice(0, 3).join(',')} ${saved.camera_type ?? ''}`.trim());
        if (peerId === fake.failRestore) return { success: false, error: 'restore boom' };
        return ok({ restored: true });
      }
      calls.push(`${peerId} ${endpoint}`);
      if (endpoint !== '/api/capture-studio') return { success: true };
      if (peerId === fake.failCapture) return { error: 'capture boom' };
      return { success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: capture.width, height: capture.height, data: capture.rgba.toString('base64') };
    });
    const budgets = jest.spyOn(
      RobloxStudioTools.prototype as unknown as { _captureViewportImage: (...values: unknown[]) => Promise<unknown> },
      '_captureViewportImage',
    );
    lastTools = new RobloxStudioTools(bridge);
    return { tools: lastTools, calls, request, budgets };
  }

  const meta = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0].text!);

  function editOnly() {
    const bridge = new BridgeService();
    return { bridge, edit: register(bridge, 'instance:edit', 'edit') };
  }

  function solo() {
    const bridge = new BridgeService();
    const edit = register(bridge, 'instance:solo', 'edit');
    register(bridge, 'instance:solo', 'server');
    return { bridge, edit, client: register(bridge, 'instance:solo', 'client-1') };
  }

  function multiplayer() {
    const bridge = new BridgeService();
    register(bridge, 'instance:controller', 'edit');
    bridge.createMultiplayerGroup('group:mp', 'instance:controller');
    register(bridge, 'instance:server', 'server', 'group:mp');
    for (const index of [3, 1, 2]) register(bridge, `instance:player${index}`, `client-${index}`, 'group:mp');
    return bridge;
  }
  const player = (index: number) => `peer:instance:player${index}:client-${index}`;

  test('max_width downscales a png before encoding and reports the original size and scale', async () => {
    const source = gradient(128, 4);
    const { tools, request } = setup(editOnly().bridge, source);

    const result = await tools.captureScreenshot('instance:edit', 'png', undefined, { max_width: 64 });
    // Studio's PNG encoding is skipped because only raw pixels can be resized.
    expect(request.mock.calls[0][1]).toEqual({ encoding: 'rgba8' });
    const info = meta(result);
    expect(info).toMatchObject({ width: 64, height: 2, originalWidth: 128, originalHeight: 4, scale: { x: 2, y: 2 }, format: 'png' });
    expect(info.message).toContain('downscaled from the 128x4 viewport to max_width 64');
    expect(info.message).toContain('multiply x read off this image by 2.0000 and y by 2.0000');

    const image = result.content[1] as { type: string; data: string };
    expect(decodePngBase64ToRgba(image.data).rgba).toEqual(downscaleRgba(source, 64, 2).rgba);
  });

  test('max_width downscales a jpeg to the requested width', async () => {
    const { tools } = setup(editOnly().bridge, gradient(300, 100));
    const result = await tools.captureScreenshot('instance:edit', 'jpeg', 80, { max_width: 150 });
    expect(meta(result)).toMatchObject({ width: 150, height: 50, originalWidth: 300, originalHeight: 100, scale: { x: 2, y: 2 }, format: 'jpeg' });
    expect(jpegSize((result.content[1] as { data: string }).data)).toEqual({ width: 150, height: 50 });
  });

  test('frames already narrow enough are returned untouched with no scale', async () => {
    const { tools } = setup(editOnly().bridge, gradient(4, 2));
    const info = meta(await tools.captureScreenshot('instance:edit', 'jpeg', 80, { max_width: 640 }));
    expect(info).toMatchObject({ width: 4, height: 2, originalWidth: 4, originalHeight: 2 });
    expect(info.scale).toBeUndefined();
    await expect(tools.captureScreenshot('instance:edit', 'jpeg', 80, { max_width: 10 })).rejects.toThrow(/at least 64/);
  });

  test('a plain capture never runs Luau or moves a camera', async () => {
    const { bridge, client } = solo();
    const { tools, calls } = setup(bridge);
    await tools.captureScreenshot('instance:solo', 'jpeg', undefined, {});
    expect(calls).toEqual([`${client} /api/capture-studio`]);
  });

  test('views move the edit camera when no playtest runs', async () => {
    const { bridge, edit } = editOnly();
    const { tools, calls } = setup(bridge);
    const result = await tools.captureScreenshot('instance:edit', 'jpeg', undefined, { views: [{ camera_position: [0, 40, 0], look_at: [0, 0, 0] }] });
    expect(result.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(calls).toEqual([`${edit} edit-set 0,40,0`, `${edit} /api/capture-studio`, `${edit} edit-restore 1,2,3`]);
  });

  test('views move the client camera the capture uses during a playtest and restore its camera type', async () => {
    const { bridge, edit, client } = solo();
    const { tools, calls } = setup(bridge);
    await tools.captureScreenshot('instance:solo', 'jpeg', undefined, { views: [{ camera_position: [5, 6, 7] }] });
    expect(calls).toEqual([`${client} client-set 5,6,7`, `${client} /api/capture-studio`, `${client} client-restore 1,2,3 Custom`]);
    expect(calls.some((call) => call.startsWith(edit))).toBe(false);
  });

  test('views are captured in order with one restore and a label list', async () => {
    const { bridge, edit } = editOnly();
    const { tools, calls } = setup(bridge);
    const result = await tools.captureScreenshot('instance:edit', 'jpeg', undefined, {
      views: [{ camera_position: [0, 50, 0], label: 'top' }, { camera_position: [20, 5, 0], look_at: [0, 0, 0] }],
    });
    expect(calls).toEqual([
      `${edit} edit-set 0,50,0`, `${edit} /api/capture-studio`,
      `${edit} edit-set 20,5,0`, `${edit} /api/capture-studio`,
      `${edit} edit-restore 1,2,3`,
    ]);
    expect(result.content.map((item) => item.type)).toEqual(['text', 'image', 'image']);
    const info = meta(result);
    expect(info.images.map((entry: Record<string, unknown>) => [entry.image, entry.label])).toEqual([[1, 'top'], [2, 'view-2']]);
    expect(info.images[0]).toMatchObject({ width: 4, height: 2, originalWidth: 4, originalHeight: 2 });
    expect(info.warnings).toBeUndefined();
  });

  test('a view the camera drifted off carries a warning on its entry', async () => {
    const { tools } = setup(solo().bridge, gradient(4, 2), { drift: [1] });
    const info = meta(await tools.captureScreenshot('instance:solo', 'jpeg', undefined, {
      views: [{ camera_position: [0, 50, 0], label: 'a' }, { camera_position: [1, 50, 0], label: 'b' }],
    }));
    expect(info.images[0].warning).toBeUndefined();
    expect(info.images[1].warning).toMatch(/did not stay at this view/);
  });

  test('a failed restore keeps the images and lands in warnings', async () => {
    const { tools } = setup(multiplayer(), gradient(4, 2), { failRestore: player(2) });
    const result = await tools.captureScreenshot('instance:controller', 'jpeg', undefined, {
      clients: ['client-1', 'client-2'],
      views: [{ camera_position: [1, 1, 1] }],
    });
    expect(result.content.map((item) => item.type)).toEqual(['text', 'image', 'image']);
    expect(meta(result).warnings).toEqual(['client-2 camera was not restored: restore boom']);
  });

  test('clients all captures every client window in client order', async () => {
    const { tools, calls } = setup(multiplayer());
    const result = await tools.captureScreenshot('instance:controller', 'jpeg', undefined, { clients: 'all' });
    expect(calls).toEqual([1, 2, 3].map((index) => `${player(index)} /api/capture-studio`));
    expect(meta(result).images.map((entry: Record<string, unknown>) => [entry.image, entry.label, entry.client, entry.instance_id])).toEqual([
      [1, 'client-1', 'client-1', 'instance:player1-client-1'],
      [2, 'client-2', 'client-2', 'instance:player2-client-2'],
      [3, 'client-3', 'client-3', 'instance:player3-client-3'],
    ]);
  });

  test('a client whose capture fails gets an error entry and the image numbers stay contiguous', async () => {
    const { tools } = setup(multiplayer(), gradient(4, 2), { failCapture: player(2) });
    const result = await tools.captureScreenshot('instance:controller', 'jpeg', undefined, { clients: 'all' });
    expect(result.content.map((item) => item.type)).toEqual(['text', 'image', 'image']);
    const entries = meta(result).images as Array<Record<string, unknown>>;
    expect(entries.map((entry) => [entry.image, entry.client])).toEqual([[1, 'client-1'], [undefined, 'client-2'], [2, 'client-3']]);
    expect(entries[1].error).toMatch(/capture boom/);
  });

  test('clients with views move each client camera and restore it before the next client', async () => {
    const { tools, calls } = setup(multiplayer());
    const result = await tools.captureScreenshot('instance:controller', 'jpeg', undefined, {
      clients: ['client-3', 'instance:player1-client-1'],
      views: [{ camera_position: [1, 1, 1], label: 'a' }, { camera_position: [2, 2, 2], label: 'b' }],
    });
    const [p3, p1] = [player(3), player(1)];
    expect(calls).toEqual([
      `${p3} client-set 1,1,1`, `${p3} /api/capture-studio`, `${p3} client-set 2,2,2`, `${p3} /api/capture-studio`, `${p3} client-restore 1,2,3 Custom`,
      `${p1} client-set 1,1,1`, `${p1} /api/capture-studio`, `${p1} client-set 2,2,2`, `${p1} /api/capture-studio`, `${p1} client-restore 1,2,3 Custom`,
    ]);
    expect(meta(result).images.map((entry: Record<string, unknown>) => `${entry.image} ${entry.client} ${entry.label}`))
      .toEqual(['1 client-3 a', '2 client-3 b', '3 client-1 a', '4 client-1 b']);
  });

  test('a single image keeps the 6 MB per image cap', async () => {
    const { tools, budgets } = setup(multiplayer());
    await tools.captureScreenshot('instance:controller', 'jpeg', undefined, { clients: ['client-1'] });
    expect(budgets.mock.calls.map((call) => call[4])).toEqual([6_000_000]);
  });

  test('twelve busy frames split the 8 MB budget over the shots still to come', async () => {
    let seed = 7;
    // The low bits of this generator repeat quickly, so each channel takes the high bits of a fresh step.
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 255;
    };
    const noise = frame(600, 600, () => [next(), next(), next(), 255]);
    const { tools, budgets } = setup(multiplayer(), noise);
    const result = await tools.captureScreenshot('instance:controller', 'jpeg', undefined, {
      clients: ['client-1', 'client-2'],
      views: Array.from({ length: 6 }, (_, index) => ({ camera_position: [index, 1, 1] })),
    });
    const images = result.content.filter((item) => item.type === 'image') as Array<{ data: string }>;
    expect(images).toHaveLength(12);
    const sizes = images.map((image) => Math.ceil((image.data.length * 3) / 4));
    let left = 8_000_000;
    const shares = sizes.map((size, index) => {
      const share = Math.floor(left / (12 - index));
      left -= size;
      return share;
    });
    expect(budgets.mock.calls.map((call) => call[4])).toEqual(shares);
    sizes.forEach((size, index) => expect(size).toBeLessThanOrEqual(shares[index]));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(8_000_000);
    // A 600x600 noise frame is about 730 KB at q92, over the first 666 KB share, and the bytes saved go to later shots.
    const qualities = (meta(result).images as Array<{ quality: number }>).map((entry) => entry.quality);
    expect(qualities[0]).toBeLessThan(92);
    expect(qualities[11]).toBe(92);
  });

  test('clients refuses unknown clients, edit-only scopes, and too many images', async () => {
    const { tools, request } = setup(multiplayer());
    await expect(tools.captureScreenshot('instance:controller', 'jpeg', undefined, { clients: ['client-9'] }))
      .rejects.toThrow(/client-9" is not a connected client/);
    await expect(tools.captureScreenshot('instance:controller', 'jpeg', undefined, { clients: 'some' }))
      .rejects.toThrow(/"all" or a non-empty array/);
    await expect(tools.captureScreenshot('instance:controller', 'jpeg', undefined, {
      clients: 'all',
      views: Array.from({ length: 5 }, (_, index) => ({ camera_position: [index, 1, 1] })),
    })).rejects.toThrow(/15 images, over the 12/);
    expect(request).not.toHaveBeenCalled();
    await lastTools?.dispose();

    const idle = new BridgeService();
    register(idle, 'instance:idle', 'edit');
    const second = setup(idle);
    await expect(second.tools.captureScreenshot('instance:idle', 'jpeg', undefined, { clients: 'all' }))
      .rejects.toThrow(/running playtest client/);
  });
});

describe('capture tool wiring', () => {
  const serialized = () => {
    const captureScreenshot = jest.fn(async () => ({ content: [] }));
    const serializeCapture = jest.fn((run: () => Promise<unknown>) => run());
    return { captureScreenshot, serializeCapture, tools: { captureScreenshot, fork: { serializeCapture } } as never };
  };

  test('capture_screenshot stays read-only and capture_views, which runs Luau, is a write tool', () => {
    const screenshot = TOOL_DEFINITIONS.find((tool) => tool.name === 'capture_screenshot')!;
    const props = Object.keys((screenshot.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(['clients', 'format', 'instance_id', 'max_width', 'quality']);
    const readOnly = getReadOnlyTools().map((tool) => tool.name);
    expect(readOnly).toContain('capture_screenshot');
    expect(readOnly).not.toContain('capture_views');
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === 'capture_views')).toMatchObject({ category: 'write' });
    expect(TOOL_HANDLERS.capture_views).toBe(captureFeature.handlers.capture_views);
  });

  test('capture_screenshot refuses camera arguments and forwards the rest serialized', async () => {
    const fake = serialized();
    for (const camera of [{ views: [{ camera_position: [1, 2, 3] }] }, { camera_position: [1, 2, 3] }, { look_at: [0, 0, 0] }]) {
      await expect(TOOL_HANDLERS.capture_screenshot(fake.tools, camera)).rejects.toThrow(/Use capture_views/);
    }
    expect(fake.captureScreenshot).not.toHaveBeenCalled();
    await TOOL_HANDLERS.capture_screenshot(fake.tools, { instance_id: 'instance:x', format: 'png', quality: 50, max_width: 800, clients: 'all' });
    expect(fake.serializeCapture).toHaveBeenCalledTimes(1);
    expect(fake.captureScreenshot).toHaveBeenCalledWith('instance:x', 'png', 50, { max_width: 800, clients: 'all' });
  });

  test('capture_views needs views and forwards them serialized', async () => {
    const fake = serialized();
    await expect(TOOL_HANDLERS.capture_views(fake.tools, { clients: 'all' })).rejects.toThrow(/views is required/);
    const body = { instance_id: 'instance:x', format: 'jpeg', quality: 70, max_width: 640, views: [{ camera_position: [1, 2, 3] }], clients: ['client-1'] };
    await TOOL_HANDLERS.capture_views(fake.tools, body);
    expect(fake.serializeCapture).toHaveBeenCalledTimes(1);
    expect(fake.captureScreenshot).toHaveBeenCalledWith('instance:x', 'jpeg', 70, { max_width: 640, views: body.views, clients: ['client-1'] });
  });
});

describe('capture Luau snippets', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-capture-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });

  // Edit and client stashes use separate keys so one can never be restored onto the other camera.
  const STASHES: Array<[string, string, string]> = [
    ['MCPCaptureEditCamera', SNIPPETS.cameraSet, SNIPPETS.cameraRestore],
    ['MCPCaptureClientCamera', SNIPPETS.clientCameraSet, SNIPPETS.clientCameraRestore],
  ];

  test('every set stashes the camera before it moves it', () => {
    for (const [key, set] of STASHES) {
      expect(set).toContain(`if _G.${key} == nil then`);
      expect(set.indexOf(`_G.${key} = {`)).toBeGreaterThan(-1);
      expect(set.indexOf(`_G.${key} = {`)).toBeLessThan(set.indexOf('camera.CFrame ='));
    }
    const client = SNIPPETS.clientCameraSet;
    expect(client.indexOf('_G.MCPCaptureClientCamera = {')).toBeLessThan(client.indexOf('camera.CameraType = Enum.CameraType.Scriptable'));
    expect(SNIPPETS.cameraSet).not.toContain('CameraType');
    expect(SNIPPETS.cameraSet).not.toContain('MCPCaptureClientCamera');
  });

  test('the client set pins the view every frame and reports whether it held', () => {
    const client = SNIPPETS.clientCameraSet;
    expect(client).toContain('camera_type = camera.CameraType.Name');
    expect(client).toContain('BindToRenderStep("MCPCaptureCamera", Enum.RenderPriority.Last.Value + 1');
    expect(client).toContain('stash.bound = pcall(');
    expect(client).toContain('held = current ~= nil and');
    expect(client).not.toMatch(/RenderStepped[:.]/);
    expect(client).toContain('stash.guard = camera:GetPropertyChangedSignal("CFrame"):Connect(');
  });

  test('restores prefer the stash, clear it, and the client one unbinds before it moves the camera back', () => {
    for (const [key, , restore] of STASHES) {
      expect(restore).toContain(`local stash = _G.${key}`);
      expect(restore).toContain(`_G.${key} = nil`);
      expect(restore).toContain('local saved = if stash ~= nil then stash.saved else ARGS.saved');
      expect(restore).toContain('return { restored = false }');
    }
    const restore = SNIPPETS.clientCameraRestore;
    expect(restore.indexOf('UnbindFromRenderStep("MCPCaptureCamera")')).toBeGreaterThan(-1);
    expect(restore.indexOf('UnbindFromRenderStep("MCPCaptureCamera")')).toBeLessThan(restore.indexOf('camera.CFrame ='));
    expect(restore.indexOf('stash.guard:Disconnect()')).toBeGreaterThan(-1);
    expect(restore.indexOf('stash.guard:Disconnect()')).toBeLessThan(restore.indexOf('camera.CFrame ='));
    expect(restore).toContain('camera.CameraType = (Enum.CameraType :: any)[saved.camera_type]');
  });
});

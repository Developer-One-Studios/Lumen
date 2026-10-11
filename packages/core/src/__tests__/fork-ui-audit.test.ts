import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { devicePresets, planDevices, summarize, uiAudit, uiAuditFeature, type DeviceRun } from '../tools/fork/ui-audit.js';
import { uiAuditLuau, type UiAuditArgs } from '../tools/fork/ui-audit-luau.js';

const PRESETS = [
  { DeviceId: 'phone-big', Name: 'Big Phone', DeviceForm: 'Phone', Width: 2796, Height: 1290, PixelDensity: 460, IsCustom: false },
  { DeviceId: 'phone-small', Name: 'iPhone SE', DeviceForm: 'Phone', Width: 1334, Height: 750, PixelDensity: 326, IsCustom: false },
  { DeviceId: 'tablet', Name: 'iPad', DeviceForm: 'Tablet', Width: 2048, Height: 1536, PixelDensity: 264, IsCustom: false },
  { DeviceId: 'tablet-mini', Name: 'iPad mini', DeviceForm: 'Tablet', Width: 2266, Height: 1488, PixelDensity: 326, IsCustom: false },
  { DeviceId: 'laptop', Name: 'Laptop', DeviceForm: 'Desktop', Width: 1366, Height: 768, PixelDensity: 96, IsCustom: false },
  { DeviceId: 'monitor-1080', Name: 'Monitor', DeviceForm: 'Desktop', Width: 1920, Height: 1080, PixelDensity: 96, IsCustom: false },
  { DeviceId: 'console', Name: 'Console', DeviceForm: 'Console', Width: 1920, Height: 1080, PixelDensity: 40, IsCustom: false },
  { DeviceId: 'mystery', Name: 'Mystery', Width: 1000, Height: 800, PixelDensity: 100, IsCustom: false },
  { DeviceId: 'my-phone', Name: 'My Phone', DeviceForm: 'Phone', Width: 640, Height: 360, PixelDensity: 400, IsCustom: true },
];

function text(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function collected(viewport: [number, number], findings: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const counts: Record<string, number> = { offscreen: 0, clipped: 0, overlap: 0, text_overflow: 0, small_text: 0, small_touch: 0, under_topbar: 0 };
  for (const finding of findings) counts[finding.kind as string] += 1;
  return { root: 'game.StarterGui', viewport, inset: [0, 58], touch: true, settled: true, elements: 12, counts, findings, ...extra };
}

type Collect = (index: number, code: string, peerId: string) => unknown;

function fakeTools(options: {
  collect: Collect;
  before?: Record<string, unknown>;
  roles?: string[];
  setFails?: (deviceId: string | undefined) => boolean;
  validate?: (code: string) => unknown;
  resetFails?: boolean;
}) {
  const events: string[] = [];
  const codes: string[] = [];
  const peers: PeerTarget[] = (options.roles ?? ['edit']).map((role) => ({ role, peerId: `p-${role}` }));
  let collects = 0;
  const forkHost: ForkHost = {
    peerTargets: async (target) => (target === 'all' ? peers : peers.filter((peer) => peer.role === target)),
    requestPeer: async (_endpoint, data, peerId) => {
      const code = (data as { code: string }).code;
      if (argsOf(code).validate) {
        events.push(`validate ${peerId}`);
        return options.validate?.(code) ?? ok({ valid: true });
      }
      codes.push(code);
      events.push(`collect ${peerId}`);
      return options.collect(collects++, code, peerId);
    },
    soloPlaytest: async () => text({}),
    getRuntimeLogs: async () => text({}),
  };
  const tools = {
    forkHost,
    getDeviceSimulatorState: async (target?: string) => {
      events.push(`state ${target}`);
      return text({ target, isSimulating: false, activeDeviceId: 'default', devices: PRESETS, ...options.before });
    },
    setDeviceSimulator: async (
      target?: string, deviceId?: string, orientation?: string, resolution?: { width: number; height: number }, density?: number, scalingMode?: string,
    ) => {
      const extras = [resolution && `${resolution.width}x${resolution.height}`, density && `${density}dpi`, scalingMode].filter(Boolean);
      events.push([`set ${target} ${deviceId} ${orientation ?? '-'}`, ...extras].join(' '));
      if (options.setFails?.(deviceId)) throw new Error(`cannot simulate ${deviceId}`);
      return text({ target, targets: {} });
    },
    resetSimulationState: async (target?: string, network?: boolean, deviceSimulator?: boolean) => {
      events.push(`reset ${target} network=${network} device=${deviceSimulator}`);
      if (options.resetFails) throw new Error('plugin gone');
      return text({ success: true });
    },
  };
  return { tools: tools as unknown as Parameters<typeof uiAudit>[0], events, codes };
}

const argsOf = (code: string) => JSON.parse(/JSONDecode\(\[=*\[\n(.*?)\]=*\]\)/s.exec(code)![1]);

describe('ui_audit device plan', () => {
  const presets = devicePresets({ devices: PRESETS });

  test('defaults to the smallest phone both ways, the smallest tablet and the desktop closest to 1080p', () => {
    expect(presets.map((preset) => preset.id)).not.toContain('my-phone');
    expect(planDevices(undefined, presets).map((entry) => entry.label)).toEqual([
      'phone-small@Portrait', 'phone-small@LandscapeLeft', 'tablet-mini@LandscapeLeft', 'monitor-1080',
    ]);
    expect(() => planDevices(undefined, [])).toThrow(/Pass devices/);
  });

  test('accepts ids, names and orientation suffixes and rejects unknown presets', () => {
    const plan = planDevices(['phone-big@Portrait', 'iPad', 'monitor-1080'], presets);
    expect(plan.map((entry) => entry.label)).toEqual(['phone-big@Portrait', 'tablet@LandscapeLeft', 'monitor-1080']);
    expect(plan[2].orientation).toBeUndefined();
    expect(() => planDevices(['nope'], presets)).toThrow(/Unknown device preset "nope". Available: phone-big/);
    expect(() => planDevices(['phone-big', 3], presets)).toThrow(/array of preset ids/);
    expect(planDevices(['custom-id@LandscapeRight'], [])).toEqual([{ id: 'custom-id', label: 'custom-id@LandscapeRight', orientation: 'LandscapeRight' }]);
  });
});

describe('ui_audit run', () => {
  test('audits each device, splits common from device-specific issues and stops simulation afterwards', async () => {
    const overflow = { kind: 'text_overflow', path: 'game.StarterGui.Shop.Title', class: 'TextLabel', rect: [10, 10, 80, 20], text: 'Legendary Bundle' };
    const offscreen = { kind: 'offscreen', path: 'game.StarterGui.Shop.Buy', class: 'TextButton', rect: [300, 600, 120, 90], onScreen: 0.4, sides: 'bottom', interactive: true };
    const { tools, events, codes } = fakeTools({
      collect: (index) => {
        if (index === 0) return ok(collected([375, 667], [overflow, offscreen]));
        if (index === 2) return { success: false, error: 'plugin timed out' };
        return ok(collected(index === 1 ? [667, 375] : [1920, 1080], [{ ...overflow, rect: [index, 10, 80, 20] }]));
      },
    });
    const result = body(await uiAudit(tools, {}, undefined));

    expect(result.target).toBe('edit');
    expect(result.root).toBe('game.StarterGui');
    expect(result.devices.map((device: { device: string }) => device.device)).toEqual([
      'phone-small@Portrait', 'phone-small@LandscapeLeft', 'tablet-mini@LandscapeLeft', 'monitor-1080',
    ]);
    expect(result.devices[0].findings).toEqual([offscreen]);
    expect(result.devices[1].findings).toEqual([]);
    expect(result.devices[2]).toEqual({ device: 'tablet-mini@LandscapeLeft', error: 'plugin timed out' });
    expect(result.summary.everyDevice).toEqual([{ ...overflow, measuredOn: 'phone-small@Portrait' }]);
    expect(result.summary.someDevices).toEqual([{ issue: 'offscreen game.StarterGui.Shop.Buy', devices: ['phone-small@Portrait'] }]);
    expect(result.restored).toEqual({ stopped: true });

    expect(events).toEqual([
      'state edit',
      'validate p-edit',
      'set edit phone-small Portrait', 'collect p-edit',
      'set edit phone-small LandscapeLeft', 'collect p-edit',
      'set edit tablet-mini LandscapeLeft', 'collect p-edit',
      'set edit monitor-1080 -', 'collect p-edit',
      'reset edit network=false device=true',
    ]);
    const args = codes.map(argsOf);
    expect(args.map((entry) => entry.touch)).toEqual([true, true, true, false]);
    expect(args[0].previous_viewport).toBeUndefined();
    expect(args[1].previous_viewport).toEqual([375, 667]);
    expect(args[3].previous_viewport).toEqual([667, 375]);
    expect(args[0].min_touch_px).toBe(44);
  });

  test('puts back the device, orientation, resolution and density simulated before, and stops simulation when that fails', async () => {
    const before = {
      isSimulating: true, activeDeviceId: 'phone-big', orientation: 'Portrait', scalingMode: 'FitToWindow',
      resolution: { x: 1290, y: 2796, width: 1290, height: 2796 }, pixelDensity: 460,
    };
    const collect = () => ok(collected([1920, 1080], []));
    const restored = fakeTools({ collect, before });
    const result = body(await uiAudit(restored.tools, { devices: ['monitor-1080'] }, undefined));
    expect(result.restored).toEqual({ device: 'phone-big', orientation: 'Portrait' });
    expect(restored.events.at(-1)).toBe('set edit phone-big Portrait 1290x2796 460dpi FitToWindow');
    expect(result.summary).toBeUndefined();

    const odd = fakeTools({ collect, before: { ...before, resolution: { width: 1290.5, height: 2796 } } });
    await uiAudit(odd.tools, { devices: ['monitor-1080'] }, undefined);
    expect(odd.events.at(-1)).toBe('set edit phone-big Portrait 460dpi FitToWindow');

    const fallback = fakeTools({ collect, before, setFails: (deviceId) => deviceId === 'phone-big' });
    const second = body(await uiAudit(fallback.tools, { devices: ['monitor-1080'] }, undefined));
    expect(second.restored).toEqual({ stopped: true, error: 'could not restore phone-big: cannot simulate phone-big' });
    expect(fallback.events.at(-1)).toBe('reset edit network=false device=true');
  });

  test('refuses to start while a custom device it could not put back is simulated', async () => {
    const { tools, events } = fakeTools({ collect: () => ok(collected([640, 360], [])), before: { isSimulating: true, activeDeviceId: 'my-phone' } });
    await expect(uiAudit(tools, {}, undefined)).rejects.toThrow('ui_audit cannot put back the custom device "my-phone" afterwards.');
    expect(events).toEqual(['state edit']);
  });

  test('rejects a bad root before switching any device', async () => {
    const { tools, events } = fakeTools({
      collect: () => ok({}),
      validate: (code) => {
        expect(argsOf(code)).toMatchObject({ root: 'PlayerGui.Hudd', validate: true, touch: null });
        return ok({ error: 'root not found: PlayerGui.Hudd' });
      },
    });
    await expect(uiAudit(tools, { root: 'PlayerGui.Hudd' }, undefined)).rejects.toThrow('root not found: PlayerGui.Hudd');
    expect(events).toEqual(['state edit', 'validate p-edit']);
  });

  test('restores the simulator when every device fails and names a failed restore in the error', async () => {
    const broken = fakeTools({ collect: () => ok({}), setFails: () => true });
    await expect(uiAudit(broken.tools, { devices: ['laptop'] }, undefined)).rejects.toThrow(/cannot simulate laptop/);
    expect(broken.events.at(-1)).toBe('reset edit network=false device=true');

    const stuck = fakeTools({ collect: () => ok({ error: 'PlayerGui not loaded yet' }), resetFails: true });
    await expect(uiAudit(stuck.tools, { devices: ['laptop', 'monitor-1080'] }, undefined)).rejects.toThrow(
      'ui_audit failed on every device: PlayerGui not loaded yet. Restore: device simulation may still be active: plugin gone',
    );
  });

  test('stops between devices when cancelled and still restores the simulator', async () => {
    const controller = new AbortController();
    const { tools, events } = fakeTools({
      collect: () => {
        controller.abort();
        return ok(collected([375, 667], []));
      },
    });
    const result = body(await uiAudit(tools, {}, undefined, controller.signal));
    expect(result.note).toBe('cancelled after 1 of 4 devices');
    expect(result.devices.map((device: { device: string }) => device.device)).toEqual(['phone-small@Portrait']);
    expect(result.restored).toEqual({ stopped: true });
    expect(events.slice(-2)).toEqual(['collect p-edit', 'reset edit network=false device=true']);
  });

  test('passes touch for known forms and lets the peer decide for presets of unknown form', async () => {
    const { tools, codes } = fakeTools({ collect: () => ok(collected([1920, 1080], [])) });
    await uiAudit(tools, { devices: ['console', 'mystery'] }, undefined);
    expect(codes.map(argsOf).map((entry) => entry.touch)).toEqual([false, null]);
  });

  test('defaults to client-1 during a playtest and refuses server targets', async () => {
    const { tools, events } = fakeTools({ roles: ['edit', 'server', 'client-1'], collect: () => ok(collected([1366, 768], [])) });
    const result = body(await uiAudit(tools, { devices: ['laptop'], checks: ['overlap', 'small_touch'] }, 'studio-1'));
    expect(result.target).toBe('client-1');
    expect(result.checks).toEqual(['overlap', 'small_touch']);
    expect(events).toEqual([
      'state client-1', 'validate p-client-1', 'set client-1 laptop -', 'collect p-client-1', 'reset client-1 network=false device=true',
    ]);
    await expect(uiAudit(tools, { target: 'server' }, undefined)).rejects.toThrow(/edit or client-N/);
    await expect(uiAudit(tools, { checks: ['offscreen', 'vibes'] }, undefined)).rejects.toThrow(/subset of offscreen/);
  });

  test('bounds findings per device and treats swapped overlap pairs as one issue', () => {
    const entry = (label: string) => ({ id: label, label });
    const overlap = (a: string, b: string) => ({ kind: 'overlap', path: a, other: b, rect: [0, 0, 50, 50], otherRect: [10, 10, 50, 50], overlap: 0.6, top: b, order: 'ZIndex' });
    const small = Array.from({ length: 5 }, (_, i) => ({ kind: 'small_text', path: `PlayerGui.Hud.Label${i}`, rect: [0, 0, 10, 10], size: 9 }));
    const runs: DeviceRun[] = [
      { entry: entry('a'), result: collected([800, 600], [...small, overlap('PlayerGui.Hud.A', 'PlayerGui.Hud.B')]) },
      { entry: entry('b'), result: collected([800, 600], [overlap('PlayerGui.Hud.B', 'PlayerGui.Hud.A')], { settled: false }) },
    ];
    const { devices, summary } = summarize(runs, 2);
    expect(summary!.everyDevice).toEqual([{ ...overlap('PlayerGui.Hud.A', 'PlayerGui.Hud.B'), measuredOn: 'a' }]);
    expect(devices[0]).toMatchObject({ findings: small.slice(0, 2), moreFindings: 3 });
    expect(summary!.someDevices).toHaveLength(2);
    expect(summary!.moreSomeDevices).toBe(3);
    expect((devices[1] as { warnings: string[] }).warnings).toEqual([
      'the layout was still changing after 2 seconds',
      'the viewport did not change from the previous device',
    ]);
  });

  test('warns about a portrait viewport nobody asked for and about devices that measured nothing', () => {
    const runs: DeviceRun[] = [
      { entry: { id: 'phone', label: 'phone@Portrait', orientation: 'Portrait' }, result: collected([375, 667], []) },
      { entry: { id: 'monitor', label: 'monitor' }, result: collected([1080, 1920], [], { elements: 0 }) },
    ];
    const edit = summarize(runs, 25, true).devices as Array<{ warnings?: string[] }>;
    expect(edit[0].warnings).toBeUndefined();
    expect(edit[1].warnings).toEqual([
      'the viewport is portrait although no orientation was asked for, so pass monitor@LandscapeLeft if that is wrong',
      'no visible GUI elements were measured, so start a playtest if scripts build the GUI at runtime',
    ]);
    const client = summarize(runs, 25, false).devices as Array<{ warnings: string[] }>;
    expect(client[1].warnings[1]).toBe('no visible GUI elements were measured, so the GUI may not be built yet');
  });
});

describe('ui_audit definition', () => {
  test('meets the catalog contracts and routes by body.instance_id', () => {
    const [definition] = uiAuditFeature.definitions;
    expect(definition.description.length).toBeLessThanOrEqual(120);
    expect(definition.description).toMatch(/^Use [^.]+\.$/);
    const properties = (definition.inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(Object.keys(properties)).toContain('instance_id');
    for (const [name, property] of Object.entries(properties)) {
      expect([name, property.description.length <= 64]).toEqual([name, true]);
    }
    expect(String(uiAuditFeature.handlers.ui_audit)).toContain('body.instance_id');
    expect(uiAuditFeature.guide).toMatch(/^## /);
  });
});

const SNIPPETS: Record<string, string> = {
  defaults: uiAuditLuau({
    checks: ['offscreen', 'clipped', 'overlap', 'text_overflow', 'small_text', 'small_touch', 'under_topbar'],
    touch: null, min_touch_px: 44, min_text_px: 12, max_findings: 500, max_interactive: 300,
  }),
  rooted: uiAuditLuau({
    root: 'PlayerGui.Shop["Main Frame"]', checks: ['overlap'], touch: true, min_touch_px: 48, min_text_px: 12,
    max_findings: 10, max_interactive: 20, previous_viewport: [375, 667],
  }),
  validate: uiAuditLuau({
    root: 'PlayerGui.Hud', checks: ['offscreen'], touch: null, min_touch_px: 44, min_text_px: 12,
    max_findings: 500, max_interactive: 300, validate: true,
  }),
};

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const runtime = spawnSync('luau', ['--help']).error ? undefined : 'luau';

// Mixed problems of every kind, laid out in an 800x600 viewport under a 58 px top bar inset.
const DEFAULT_GUI = String.raw`{
	make("ScreenGui", { Name = "Hud" }, {
		make("TextButton", { Name = "Play", pos = { 700, 500 }, size = { 200, 60 }, Text = "Play" }, {
			make("TextLabel", { Name = "Glyph", pos = { 850, 510 }, size = { 20, 20 }, Text = "x" }),
		}),
		make("Frame", { Name = "Panel", pos = { 0, 0 }, size = { 300, 200 }, ClipsDescendants = true }, {
			make("TextLabel", { Name = "Title", pos = { 250, 10 }, size = { 100, 30 }, Text = "Legendary bundle", TextFits = false, TextBounds = v2(140, 14) }),
		}),
		make("TextButton", { Name = "Tiny", pos = { 10, 300 }, size = { 20, 20 }, Text = "?" }),
		make("TextLabel", { Name = "Fine", pos = { 10, 400 }, size = { 200, 20 }, Text = "terms apply", TextSize = 8 }),
		make("TextButton", { Name = "Buy", pos = { 400, 300 }, size = { 100, 50 }, Text = "Buy", ZIndex = 2 }),
		make("ImageButton", { Name = "Close", pos = { 420, 310 }, size = { 100, 50 }, BackgroundTransparency = 1 }),
		make("Frame", { Name = "Hidden", pos = { 0, 0 }, size = { 10, 10 }, Visible = false }, {
			make("TextButton", { Name = "Ghost", pos = { 900, 900 }, size = { 50, 50 }, Text = "boo" }),
		}),
		make("ScrollingFrame", { Name = "List", pos = { 500, 100 }, size = { 200, 100 } }, {
			make("TextLabel", { Name = "Row", pos = { 500, 180 }, size = { 200, 50 }, Text = "row" }),
		}),
	}),
	make("ScreenGui", { Name = "Top", IgnoreGuiInset = true }, {
		make("TextButton", { Name = "Menu", pos = { 10, -58 }, size = { 60, 44 }, Text = "=" }),
		make("TextButton", { Name = "TopOk", pos = { 200, -58 }, size = { 60, 44 }, Text = "ok" }),
	}),
	make("ScreenGui", { Name = "Popup", DisplayOrder = 5 }, {
		make("TextButton", { Name = "Ok", pos = { 410, 305 }, size = { 80, 44 }, Text = "Ok" }),
	}),
	make("BillboardGui", { Name = "Nameplate" }, {
		make("TextButton", { Name = "Far", pos = { -500, -500 }, size = { 5, 5 }, Text = "far" }),
	}),
}`;

// Nested and clipped edge cases and render order ties, in the same viewport.
const EDGE_GUI = String.raw`{
	make("ScreenGui", { Name = "Hud" }, {
		make("Frame", { Name = "Panel", pos = { 500, 0 }, size = { 302, 100 } }, {
			make("TextLabel", { Name = "Caption", pos = { 500, 10 }, size = { 302, 20 }, Text = "Daily rewards" }),
			make("TextButton", { Name = "Close", pos = { 810, 40 }, size = { 44, 44 }, Text = "X" }, {
				make("TextLabel", { Name = "Icon", pos = { 815, 45 }, size = { 10, 10 }, Text = "x" }),
			}),
			make("TextLabel", { Name = "Badge", pos = { 805, 80 }, size = { 20, 20 }, Text = "3" }),
		}),
		make("Frame", { Name = "Carousel", pos = { 0, 150 }, size = { 200, 100 }, ClipsDescendants = true }, {
			make("Frame", { Name = "Slide1", pos = { 0, 150 }, size = { 200, 100 } }),
			make("Frame", { Name = "Slide2", pos = { 700, 150 }, size = { 200, 100 } }, {
				make("TextButton", { Name = "Claim", pos = { 720, 170 }, size = { 60, 44 }, Text = "Claim" }),
			}),
		}),
		make("Frame", { Name = "Window", pos = { 250, 150 }, size = { 300, 100 }, ClipsDescendants = true, BackgroundTransparency = 1 }, {
			make("Frame", { Name = "Card", pos = { 250, 150 }, size = { 306, 100 } }, {
				make("TextLabel", { Name = "Line", pos = { 250, 160 }, size = { 306, 20 }, Text = "Card text" }),
				make("TextButton", { Name = "More", pos = { 560, 200 }, size = { 44, 44 }, Text = "More" }),
			}),
		}),
	}),
	make("ScreenGui", { Name = "Board", ZIndexBehavior = Enum.ZIndexBehavior.Global }, {
		make("Frame", { Name = "Group", pos = { 0, 350 }, size = { 300, 100 }, ZIndex = 5 }, {
			make("TextButton", { Name = "Low", pos = { 10, 360 }, size = { 100, 50 }, Text = "Low" }),
		}),
		make("TextButton", { Name = "High", pos = { 30, 370 }, size = { 100, 50 }, Text = "High", ZIndex = 3 }),
		make("TextButton", { Name = "TieA", pos = { 200, 360 }, size = { 60, 50 }, Text = "A", ZIndex = 2 }),
		make("TextButton", { Name = "TieB", pos = { 210, 365 }, size = { 60, 50 }, Text = "B", ZIndex = 2 }),
	}),
	make("ScreenGui", { Name = "Left" }, {
		make("TextButton", { Name = "LeftBtn", pos = { 400, 350 }, size = { 100, 50 }, Text = "L" }),
		make("TextButton", { Name = "Disabled", pos = { 600, 350 }, size = { 20, 20 }, Text = "-", Interactable = false }),
		make("TextButton", { Name = "Active", pos = { 605, 355 }, size = { 60, 44 }, Text = "Go" }),
	}),
	make("ScreenGui", { Name = "Right" }, {
		make("TextButton", { Name = "RightBtn", pos = { 420, 360 }, size = { 100, 50 }, Text = "R" }),
	}),
}`;

// A small stand-in for the engine: instances with fixed absolute rects, and the services the collector reads.
const HARNESS = String.raw`
local function enumItem(enumName, name)
	return setmetatable({ Name = name }, { __type = "EnumItem", __tostring = function() return "Enum." .. enumName .. "." .. name end })
end
local Enum = {
	ZIndexBehavior = { Global = enumItem("ZIndexBehavior", "Global"), Sibling = enumItem("ZIndexBehavior", "Sibling") },
	TextTruncate = { None = enumItem("TextTruncate", "None"), AtEnd = enumItem("TextTruncate", "AtEnd") },
	ScreenOrientation = { Portrait = enumItem("ScreenOrientation", "Portrait") },
}
local function typeof(value)
	local meta = getmetatable(value)
	if type(meta) == "table" and meta.__type then return meta.__type end
	return type(value)
end
local task = { wait = function() return 1 / 60 end }
local function v2(x, y) return { X = x, Y = y } end
local function rect(x0, y0, x1, y1)
	return setmetatable({ Min = v2(x0, y0), Max = v2(x1, y1), Width = x1 - x0, Height = y1 - y0 }, { __type = "Rect" })
end

local ISA = {
	ScreenGui = { "LayerCollector" }, BillboardGui = { "LayerCollector" },
	Frame = { "GuiObject" }, ScrollingFrame = { "GuiObject" }, TextLabel = { "GuiObject" }, TextBox = { "GuiObject" },
	TextButton = { "GuiButton", "GuiObject" }, ImageButton = { "GuiButton", "GuiObject" },
}
local DEFAULTS = {
	Visible = true, BackgroundTransparency = 0, ZIndex = 1, ClipsDescendants = false, Enabled = true, DisplayOrder = 0,
	Text = "", TextTransparency = 0, TextFits = true, TextScaled = false, TextWrapped = false, TextSize = 14, LineHeight = 1,
	Image = "", ImageTransparency = 0, PlaceholderText = "", IgnoreGuiInset = false,
}
local Instance = {}
Instance.__index = Instance
function Instance:IsA(className)
	return self.ClassName == className or table.find(ISA[self.ClassName] or {}, className) ~= nil
end
function Instance:GetDescendants()
	local out = {}
	local function walk(node)
		for _, child in node._children do
			table.insert(out, child)
			walk(child)
		end
	end
	walk(self)
	return out
end
function Instance:FindFirstChild(name)
	for _, child in self._children do if child.Name == name then return child end end
	return nil
end
function Instance:FindFirstChildOfClass(className)
	for _, child in self._children do if child.ClassName == className then return child end end
	return nil
end
function Instance:FindFirstChildWhichIsA(className)
	for _, child in self._children do if child:IsA(className) then return child end end
	return nil
end
function Instance:IsDescendantOf(other)
	local current = self.Parent
	while current do
		if current == other then return true end
		current = current.Parent
	end
	return false
end
function Instance:IsAncestorOf(other) return other:IsDescendantOf(self) end

local function make(className, props, children)
	local node = setmetatable({ ClassName = className, Name = className, _children = {} }, Instance)
	if ISA[className] then
		for key, value in DEFAULTS do node[key] = value end
		node.TextTruncate = Enum.TextTruncate.None
		node.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
		node.TextBounds = v2(40, 14)
	end
	for key, value in props do
		if key == "pos" then
			node.AbsolutePosition = v2(value[1], value[2])
		elseif key == "size" then
			node.AbsoluteSize = v2(value[1], value[2])
		else
			node[key] = value
		end
	end
	for _, child in children or {} do
		child.Parent = node
		table.insert(node._children, child)
	end
	return node
end

local services = {}
local game = make("DataModel", { Name = "Game" })
function game.GetService(_, name)
	local found = services[name]
	if found == nil then error("no service " .. name) end
	return found
end
local function service(name, props, children)
	local node = make(name, props or {}, children)
	node.Parent = game
	table.insert(game._children, node)
	services[name] = node
	return node
end

local gui = __GUI__

local EDIT = __EDIT__
local players = service("Players")
if EDIT then
	service("StarterGui", { ShowDevelopmentGui = true }, gui)
else
	service("StarterGui", { ShowDevelopmentGui = true })
	local player = make("Player", { Name = "Tester" }, { make("PlayerGui", { Name = "PlayerGui" }, gui) })
	player.Parent = players
	table.insert(players._children, player)
	players.LocalPlayer = player
end
service("GuiService", { TopbarInset = rect(100, 0, 700, 58), GetGuiInset = function() return v2(0, 58), v2(0, 0) end })
service("UserInputService", { TouchEnabled = false })
service("Workspace", { CurrentCamera = { ViewportSize = v2(800, 600) } })
service("HttpService", { JSONDecode = function() return __ARGS__ end })
service("StudioDeviceSimulatorService", {
	GetDeviceAsync = function() return "phone-small" end,
	GetOrientationAsync = function() return Enum.ScreenOrientation.Portrait end,
})

local function encode(value)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" or kind == "number" then return tostring(value) end
	if kind == "string" then
		return '"' .. (string.gsub(value, '[%c"\\]', function(c) return string.format("\\u%04x", string.byte(c)) end)) .. '"'
	end
	if kind == "table" then
		local parts = {}
		if #value > 0 or next(value) == nil then
			for _, item in ipairs(value) do table.insert(parts, encode(item)) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for key, item in value do table.insert(parts, encode(tostring(key)) .. ":" .. encode(item)) end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return encode(tostring(value))
end
`;

function luauLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{ ${value.map(luauLiteral).join(', ')} }`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([key, item]) => `[${JSON.stringify(key)}] = ${luauLiteral(item)}`).join(', ')} }`;
}

function runCollector(args: UiAuditArgs, edit = false, gui = DEFAULT_GUI) {
  const harness = HARNESS.replace('__GUI__', () => gui).replace('__EDIT__', () => String(edit)).replace('__ARGS__', () => luauLiteral(args));
  const source = `${harness}\nlocal function collector()\n${uiAuditLuau(args)}\nend\nprint(encode(collector()))\n`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ui-audit-run-')), 'collector.luau');
  fs.writeFileSync(file, source);
  const result = spawnSync(runtime!, [file], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

const ALL_CHECKS: UiAuditArgs['checks'] = ['offscreen', 'clipped', 'overlap', 'text_overflow', 'small_text', 'small_touch', 'under_topbar'];
const runArgs = (extra: Partial<UiAuditArgs> = {}): UiAuditArgs => ({
  checks: ALL_CHECKS, touch: true, min_touch_px: 44, min_text_px: 12, max_findings: 500, max_interactive: 300,
  previous_viewport: [375, 667], ...extra,
});

describe('ui_audit Luau', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ui-audit-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });

  (runtime ? test : test.skip)('collector finds each kind of layout problem on a mocked client GUI', () => {
    const result = runCollector(runArgs());
    expect(result).toMatchObject({
      root: 'PlayerGui', viewport: [800, 600], inset: [0, 58], topbarFree: [100, 0, 600, 58], touch: true, settled: true,
      simulatedDevice: 'phone-small', simulatedOrientation: 'Portrait',
      counts: { offscreen: 1, clipped: 1, overlap: 3, text_overflow: 1, small_text: 1, small_touch: 1, under_topbar: 1 },
    });
    const byKind = (kind: string) => result.findings.filter((finding: { kind: string }) => finding.kind === kind);
    expect(byKind('offscreen')).toEqual([{
      kind: 'offscreen', path: 'PlayerGui.Hud.Play', class: 'TextButton', rect: [700, 558, 200, 60], onScreen: 0.35, sides: 'right,bottom', interactive: true, nested: 1,
    }]);
    expect(byKind('clipped')).toEqual([{ kind: 'clipped', path: 'PlayerGui.Hud.Panel.Title', class: 'TextLabel', rect: [250, 68, 100, 30], by: 'PlayerGui.Hud.Panel', shown: 0.5 }]);
    expect(byKind('text_overflow')).toEqual([{ kind: 'text_overflow', path: 'PlayerGui.Hud.Panel.Title', class: 'TextLabel', rect: [250, 68, 100, 30], text: 'Legendary bundle', bounds: [140, 14] }]);
    expect(byKind('small_text')).toEqual([{ kind: 'small_text', path: 'PlayerGui.Hud.Fine', class: 'TextLabel', rect: [10, 458, 200, 20], text: 'terms apply', size: 8 }]);
    expect(byKind('small_touch').map((finding: { path: string }) => finding.path)).toEqual(['PlayerGui.Hud.Tiny']);
    expect(byKind('under_topbar')).toEqual([{ kind: 'under_topbar', path: 'PlayerGui.Top.Menu', class: 'TextButton', rect: [10, 0, 60, 44], band: 58 }]);
    expect(byKind('overlap').map((finding: Record<string, unknown>) => [finding.path, finding.other, finding.overlap, finding.top, finding.order, finding.invisible])).toEqual([
      ['PlayerGui.Hud.Buy', 'PlayerGui.Hud.Close', 0.64, 'PlayerGui.Hud.Buy', 'sibling ZIndex', 'PlayerGui.Hud.Close'],
      ['PlayerGui.Hud.Buy', 'PlayerGui.Popup.Ok', 1, 'PlayerGui.Popup.Ok', 'DisplayOrder', undefined],
      ['PlayerGui.Hud.Close', 'PlayerGui.Popup.Ok', 0.78, 'PlayerGui.Popup.Ok', 'DisplayOrder', 'PlayerGui.Hud.Close'],
    ]);
  });

  (runtime ? test : test.skip)('collector reads StarterGui in edit mode and honours root, checks and touch', () => {
    const result = runCollector(runArgs({ root: 'game.StarterGui.Hud', checks: ['overlap', 'small_touch'], touch: false }), true);
    expect(result.root).toBe('game.StarterGui.Hud');
    expect(result.counts).toEqual({ overlap: 1, small_touch: 0 });
    expect(result.findings[0]).toMatchObject({ path: 'game.StarterGui.Hud.Buy', other: 'game.StarterGui.Hud.Close' });
    expect(runCollector(runArgs({ root: 'game.StarterGui.Nope' }), true)).toEqual({ error: 'root not found: game.StarterGui.Nope' });
    expect(runCollector(runArgs({ root: 'game.Workspace' }), true)).toEqual({ error: 'root must be inside StarterGui' });
  });

  (runtime ? test : test.skip)('validate mode only resolves the root', () => {
    expect(runCollector(runArgs({ root: 'PlayerGui.Hud', validate: true }))).toEqual({ valid: true });
    expect(runCollector(runArgs({ root: 'PlayerGui.Hudd', validate: true }))).toEqual({ error: 'root not found: PlayerGui.Hudd' });
  });

  (runtime ? test : test.skip)('collector keeps hidden buttons under barely broken parents, blames clipping on the clipper and orders ties', () => {
    const result = runCollector(runArgs(), false, EDGE_GUI);
    expect(result.counts).toEqual({ offscreen: 3, clipped: 3, overlap: 3, text_overflow: 0, small_text: 0, small_touch: 0, under_topbar: 0 });
    const byKind = (kind: string) => result.findings.filter((finding: { kind: string }) => finding.kind === kind);
    expect(byKind('offscreen')).toEqual([
      { kind: 'offscreen', path: 'PlayerGui.Hud.Panel', class: 'Frame', rect: [500, 58, 302, 100], onScreen: 0.99, sides: 'right', nested: 1 },
      { kind: 'offscreen', path: 'PlayerGui.Hud.Panel.Close', class: 'TextButton', rect: [810, 98, 44, 44], onScreen: 0, sides: 'right', interactive: true, nested: 1 },
      { kind: 'offscreen', path: 'PlayerGui.Hud.Panel.Badge', class: 'TextLabel', rect: [805, 138, 20, 20], onScreen: 0, sides: 'right' },
    ]);
    expect(byKind('clipped')).toEqual([
      { kind: 'clipped', path: 'PlayerGui.Hud.Carousel.Slide2', class: 'Frame', rect: [700, 208, 200, 100], by: 'PlayerGui.Hud.Carousel', shown: 0, nested: 1 },
      { kind: 'clipped', path: 'PlayerGui.Hud.Window.Card', class: 'Frame', rect: [250, 208, 306, 100], by: 'PlayerGui.Hud.Window', shown: 0.98, nested: 1 },
      { kind: 'clipped', path: 'PlayerGui.Hud.Window.Card.More', class: 'TextButton', rect: [560, 258, 44, 44], by: 'PlayerGui.Hud.Window', shown: 0, interactive: true },
    ]);
    expect(byKind('overlap').map((finding: Record<string, unknown>) => [finding.path, finding.other, finding.overlap, finding.top, finding.order])).toEqual([
      ['PlayerGui.Board.Group.Low', 'PlayerGui.Board.High', 0.64, 'PlayerGui.Board.High', 'ZIndex'],
      ['PlayerGui.Board.TieA', 'PlayerGui.Board.TieB', 0.75, undefined, 'same ZIndex'],
      ['PlayerGui.Left.LeftBtn', 'PlayerGui.Right.RightBtn', 0.64, undefined, 'same DisplayOrder'],
    ]);
  });
});

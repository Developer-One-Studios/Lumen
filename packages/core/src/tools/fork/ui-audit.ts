import type { RobloxStudioTools } from '../index.js';
import { clamp, luauValue, parseResult, toolText, wait, type ForkHost } from '../fork-tools.js';
import type { ForkFeature } from './feature.js';
import { UI_AUDIT_CHECKS, uiAuditLuau, type UiAuditCheck } from './ui-audit-luau.js';

type AuditTools = Pick<RobloxStudioTools, 'forkHost' | 'getDeviceSimulatorState' | 'setDeviceSimulator' | 'resetSimulationState'>;

export interface DevicePreset {
  id: string;
  name?: string;
  form?: string;
  width?: number;
  height?: number;
  density?: number;
}

export interface DevicePlanEntry {
  id: string;
  label: string;
  orientation?: string;
  name?: string;
  form?: string;
}

type Finding = Record<string, unknown> & { kind: string; path: string; other?: unknown };
export type DeviceRun = { entry: DevicePlanEntry; result?: Record<string, unknown>; error?: string };

const EXECUTE = '/api/execute-luau';
const SETTLE_MS = 300;
const MIN_TEXT_PX = 12;
const MAX_FINDINGS = 500;
const MAX_INTERACTIVE = 300;
const MAX_DEVICES = 8;
const ORIENTATION_SUFFIX = /^(.+)@(Portrait|LandscapeLeft|LandscapeRight)$/;
const TOUCH_FORMS = new Set(['Phone', 'Tablet']);
const KNOWN_FORMS = new Set(['Phone', 'Tablet', 'Desktop', 'Console', 'VR']);
const RANK: Record<string, number> = {
  overlap: 0, offscreen: 1, under_topbar: 2, small_touch: 3, text_overflow: 4, clipped: 5, small_text: 6,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function devicePresets(state: Record<string, unknown>): DevicePreset[] {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  return devices.flatMap((entry): DevicePreset[] => {
    if (!entry || typeof entry !== 'object') return [];
    const device = entry as Record<string, unknown>;
    // The simulator tools only accept built-in presets.
    if (device.IsCustom === true) return [];
    const id = device.DeviceId ?? device.deviceId ?? device.Id ?? device.id;
    if (typeof id !== 'string' && typeof id !== 'number') return [];
    return [{
      id: String(id),
      name: typeof device.Name === 'string' ? device.Name : undefined,
      form: typeof device.DeviceForm === 'string' ? device.DeviceForm : undefined,
      width: positive(device.Width),
      height: positive(device.Height),
      density: positive(device.PixelDensity),
    }];
  });
}

// Phones and tablets run in landscape unless asked otherwise, since most Roblox mobile play is landscape.
function planEntry(preset: DevicePreset, orientation?: string): DevicePlanEntry {
  const chosen = orientation ?? (preset.form && TOUCH_FORMS.has(preset.form) ? 'LandscapeLeft' : undefined);
  return {
    id: preset.id,
    label: chosen ? `${preset.id}@${chosen}` : preset.id,
    ...(chosen ? { orientation: chosen } : {}),
    ...(preset.name ? { name: preset.name } : {}),
    ...(preset.form ? { form: preset.form } : {}),
  };
}

function ascending(key: (preset: DevicePreset) => number) {
  return (a: DevicePreset, b: DevicePreset) => {
    const difference = key(a) - key(b);
    return Number.isNaN(difference) ? 0 : difference;
  };
}

function defaultPlan(presets: DevicePreset[]): DevicePlanEntry[] {
  const inches = (p: DevicePreset) => (p.width && p.height && p.density ? Math.hypot(p.width, p.height) / p.density : Infinity);
  const pixels = (p: DevicePreset) => (p.width && p.height ? p.width * p.height : Infinity);
  const smallest = (form: string) => presets
    .filter((p) => p.form === form)
    .sort((a, b) => ascending(inches)(a, b) || ascending(pixels)(a, b))[0];
  const fullHd = (p: DevicePreset) => (p.width && p.height
    ? Math.abs(Math.max(p.width, p.height) - 1920) + Math.abs(Math.min(p.width, p.height) - 1080)
    : Infinity);
  const phone = smallest('Phone');
  const tablet = smallest('Tablet');
  const desktop = presets.filter((p) => p.form === 'Desktop').sort(ascending(fullHd))[0];
  const plan = [
    ...(phone ? [planEntry(phone, 'Portrait'), planEntry(phone, 'LandscapeLeft')] : []),
    ...(tablet ? [planEntry(tablet, 'LandscapeLeft')] : []),
    ...(desktop ? [planEntry(desktop)] : []),
  ];
  if (plan.length === 0) throw new Error('No phone, tablet or desktop device presets were found. Pass devices with preset ids.');
  return plan;
}

export function planDevices(requested: unknown, presets: DevicePreset[]): DevicePlanEntry[] {
  if (requested === undefined || (Array.isArray(requested) && requested.length === 0)) return defaultPlan(presets);
  if (!Array.isArray(requested) || requested.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('devices must be an array of preset ids, each optionally suffixed with @Portrait, @LandscapeLeft or @LandscapeRight');
  }
  if (requested.length > MAX_DEVICES) throw new Error(`devices takes at most ${MAX_DEVICES} presets per call`);
  return (requested as string[]).map((raw) => {
    const match = ORIENTATION_SUFFIX.exec(raw);
    const id = match ? match[1] : raw;
    const preset = presets.find((p) => p.id === id) ?? presets.find((p) => p.name?.toLowerCase() === id.toLowerCase());
    if (!preset && presets.length > 0) {
      throw new Error(`Unknown device preset "${id}". Available: ${presets.slice(0, 40).map((p) => p.id).join(', ')}`);
    }
    return planEntry(preset ?? { id }, match?.[2]);
  });
}

function parseChecks(value: unknown): UiAuditCheck[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [...UI_AUDIT_CHECKS];
  const known: readonly string[] = UI_AUDIT_CHECKS;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !known.includes(item))) {
    throw new Error(`checks must be a subset of ${UI_AUDIT_CHECKS.join(', ')}`);
  }
  return [...new Set(value as UiAuditCheck[])];
}

async function pickTarget(host: ForkHost, target: unknown, instanceId: string | undefined): Promise<string> {
  if (typeof target === 'string' && target !== '') {
    if (target !== 'edit' && !/^client-\d+$/.test(target)) throw new Error('target must be edit or client-N, since a server has no GUI to audit');
    return target;
  }
  const roles = (await host.peerTargets('all', instanceId)).map((peer) => peer.role);
  return roles.includes('client-1') ? 'client-1' : roles.find((role) => /^client-\d+$/.test(role)) ?? 'edit';
}

function activeDevice(state: Record<string, unknown>): string | undefined {
  return state.isSimulating === true && typeof state.activeDeviceId === 'string' && state.activeDeviceId !== 'default'
    ? state.activeDeviceId
    : undefined;
}

// set_device_simulator rejects anything but positive integers, which would lose the whole restore.
function resolutionOf(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return Number.isInteger(width) && Number.isInteger(height) && (width as number) > 0 && (height as number) > 0
    ? { width: width as number, height: height as number }
    : undefined;
}

/** Puts back the device, orientation, resolution, density and scaling that were active before the audit, or stops simulation. */
async function restoreSimulator(
  tools: AuditTools,
  target: string,
  before: Record<string, unknown>,
  instanceId: string | undefined,
): Promise<Record<string, unknown>> {
  const device = activeDevice(before);
  let failure: string | undefined;
  if (device) {
    const orientation = typeof before.orientation === 'string' ? before.orientation : undefined;
    const scalingMode = typeof before.scalingMode === 'string' ? before.scalingMode : undefined;
    try {
      await tools.setDeviceSimulator(
        target, device, orientation, resolutionOf(before.resolution), positive(before.pixelDensity), scalingMode, undefined, instanceId,
      );
      return { device, ...(orientation ? { orientation } : {}) };
    } catch (error) {
      failure = message(error);
    }
  }
  try {
    await tools.resetSimulationState(target, false, true, instanceId);
    return failure ? { stopped: true, error: `could not restore ${device}: ${failure}` } : { stopped: true };
  } catch (error) {
    return { error: `device simulation may still be active: ${message(error)}` };
  }
}

function findingsOf(result: Record<string, unknown>): Finding[] {
  const raw: unknown[] = Array.isArray(result.findings) ? result.findings : [];
  const findings = raw.filter((item): item is Finding =>
    !!item && typeof item === 'object' && typeof (item as Finding).kind === 'string' && typeof (item as Finding).path === 'string');
  const severity = (finding: Finding) => (RANK[finding.kind] ?? 9) * 2 + (finding.interactive === true ? 0 : 1);
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => severity(a.finding) - severity(b.finding) || a.index - b.index)
    .map(({ finding }) => finding);
}

export function issueKey(finding: Finding): string {
  if (finding.kind === 'overlap') return `overlap ${[finding.path, String(finding.other)].sort().join(' | ')}`;
  return `${finding.kind} ${finding.path}`;
}

function viewportOf(result: Record<string, unknown>): [number, number] | undefined {
  const viewport = result.viewport;
  return Array.isArray(viewport) && viewport.length === 2 && viewport.every((n) => typeof n === 'number')
    ? [viewport[0], viewport[1]]
    : undefined;
}

export function summarize(runs: DeviceRun[], limit: number, edit = false) {
  const audited = runs.flatMap((run) => (run.result ? [{ run, findings: findingsOf(run.result) }] : []));
  const presence = new Map<string, string[]>();
  for (const { run, findings } of audited) {
    for (const key of new Set(findings.map(issueKey))) presence.set(key, [...(presence.get(key) ?? []), run.entry.label]);
  }
  // With one device there is nothing to compare, so every finding stays on that device.
  const compare = audited.length >= 2;
  const everywhere = new Set(compare ? [...presence].filter(([, labels]) => labels.length === audited.length).map(([key]) => key) : []);

  let previous: [number, number] | undefined;
  const devices = runs.map((run) => {
    if (!run.result) return { device: run.entry.label, error: run.error };
    const result = run.result;
    const all = findingsOf(result);
    const specific = all.filter((finding) => !everywhere.has(issueKey(finding)));
    const counts = (result.counts && typeof result.counts === 'object' && !Array.isArray(result.counts) ? result.counts : {}) as Record<string, number>;
    const total = Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
    const viewport = viewportOf(result);
    const warnings: string[] = [];
    if (result.settled === false) warnings.push('the layout was still changing after 2 seconds');
    if (typeof result.simulatedDevice === 'string' && result.simulatedDevice !== run.entry.id) {
      warnings.push(`the simulator reports device ${result.simulatedDevice}, so the preset may not have applied`);
    }
    if (viewport && previous && viewport[0] === previous[0] && viewport[1] === previous[1]) {
      warnings.push('the viewport did not change from the previous device');
    }
    // Switching presets may keep the previous orientation, which would lay a desktop out as a tall portrait screen.
    if (!run.entry.orientation && viewport && viewport[1] > viewport[0]) {
      warnings.push(`the viewport is portrait although no orientation was asked for, so pass ${run.entry.id}@LandscapeLeft if that is wrong`);
    }
    if (result.elements === 0) {
      warnings.push(edit
        ? 'no visible GUI elements were measured, so start a playtest if scripts build the GUI at runtime'
        : 'no visible GUI elements were measured, so the GUI may not be built yet');
    }
    if (result.developmentGuiHidden === true) warnings.push('StarterGui.ShowDevelopmentGui is off, so edit mode GUIs may not be laid out');
    if (result.interactiveTruncated === true) warnings.push(`only the first ${MAX_INTERACTIVE} interactive elements were checked for overlap`);
    if (total > all.length) warnings.push(`only the first ${all.length} of ${total} findings were collected`);
    previous = viewport ?? previous;
    return {
      device: run.entry.label,
      ...(run.entry.name ? { name: run.entry.name } : {}),
      ...(run.entry.form ? { form: run.entry.form } : {}),
      orientation: result.simulatedOrientation ?? run.entry.orientation,
      viewport: result.viewport,
      inset: result.inset,
      ...(result.topbarFree ? { topbarFree: result.topbarFree } : {}),
      touch: result.touch,
      elements: result.elements,
      counts,
      findings: specific.slice(0, limit),
      ...(specific.length > limit ? { moreFindings: specific.length - limit } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });

  if (!compare) return { devices };
  // Rects and measurements differ per device, so common issues keep the first device's and name it.
  const measuredOn = audited[0].run.entry.label;
  const common = audited[0].findings
    .filter((finding, index, all) => everywhere.has(issueKey(finding)) && all.findIndex((other) => issueKey(other) === issueKey(finding)) === index)
    .map((finding) => ({ ...finding, measuredOn }));
  const partial = [...presence]
    .filter(([key]) => !everywhere.has(key))
    .map(([issue, labels]) => ({ issue, devices: labels }))
    .sort((a, b) => a.devices.length - b.devices.length || (RANK[a.issue.split(' ')[0]] ?? 9) - (RANK[b.issue.split(' ')[0]] ?? 9));
  return {
    devices,
    summary: {
      everyDevice: common.slice(0, limit),
      ...(common.length > limit ? { moreEveryDevice: common.length - limit } : {}),
      someDevices: partial.slice(0, limit),
      ...(partial.length > limit ? { moreSomeDevices: partial.length - limit } : {}),
    },
  };
}

export async function uiAudit(tools: AuditTools, body: Record<string, unknown>, instanceId: string | undefined, signal?: AbortSignal) {
  const checks = parseChecks(body.checks);
  const limit = clamp(body.limit, 25, 1, 200);
  const minTouch = clamp(body.min_touch_px, 44, 1, 400);
  const root = typeof body.root === 'string' && body.root !== '' ? body.root : undefined;
  const target = await pickTarget(tools.forkHost, body.target, instanceId);
  const peers = await tools.forkHost.peerTargets(target, instanceId);
  if (peers.length !== 1) throw new Error(`target must name one peer, ${peers.length} matched`);
  const before = parseResult(await tools.getDeviceSimulatorState(target, undefined, true, instanceId));
  const presets = devicePresets(before);
  const plan = planDevices(body.devices, presets);
  const active = activeDevice(before);
  if (active && !presets.some((preset) => preset.id === active)) {
    throw new Error(`ui_audit cannot put back the custom device "${active}" afterwards. Switch the simulator to a built-in preset or stop simulating first.`);
  }

  const args = { root, checks, min_touch_px: minTouch, min_text_px: MIN_TEXT_PX, max_findings: MAX_FINDINGS, max_interactive: MAX_INTERACTIVE };
  // A bad root or a missing PlayerGui fails here, before the simulator flips through every preset.
  luauValue(await tools.forkHost.requestPeer(EXECUTE, { code: uiAuditLuau({ ...args, touch: null, validate: true }) }, peers[0].peerId, 30_000));

  const runs: DeviceRun[] = [];
  let restored: Record<string, unknown>;
  try {
    let previous: [number, number] | undefined;
    for (const entry of plan) {
      if (signal?.aborted) break;
      try {
        await tools.setDeviceSimulator(target, entry.id, entry.orientation, undefined, undefined, undefined, undefined, instanceId);
        await wait(SETTLE_MS);
        const code = uiAuditLuau({
          ...args,
          touch: entry.form && KNOWN_FORMS.has(entry.form) ? TOUCH_FORMS.has(entry.form) : null,
          previous_viewport: previous,
        });
        const result = luauValue(await tools.forkHost.requestPeer(EXECUTE, { code }, peers[0].peerId, 60_000));
        runs.push({ entry, result });
        previous = viewportOf(result) ?? previous;
      } catch (error) {
        runs.push({ entry, error: message(error) });
      }
    }
  } finally {
    restored = await restoreSimulator(tools, target, before, instanceId);
  }

  // The same failure on every device is the tool failing, not a per-device result.
  if (runs.length > 0 && runs.every((run) => run.error !== undefined)) {
    const restore = typeof restored.error === 'string' ? `. Restore: ${restored.error}` : '';
    throw new Error(`ui_audit failed on every device: ${[...new Set(runs.map((run) => run.error))].join('; ')}${restore}`);
  }
  const { devices, summary } = summarize(runs, limit, target === 'edit');
  return toolText({
    target,
    root: runs.find((run) => run.result)?.result?.root,
    checks,
    devices,
    ...(summary ? { summary } : {}),
    restored,
    ...(runs.length < plan.length ? { note: `cancelled after ${runs.length} of ${plan.length} devices` } : {}),
  });
}

export const uiAuditFeature: ForkFeature = {
  name: 'ui-audit',
  definitions: [
    {
      name: 'ui_audit',
      category: 'write',
      // It switches the device simulator and puts it back, so nothing it changes outlasts the call.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Use to find offscreen, clipped, overlapping, unreadable or too small GUI elements across device sizes in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          devices: {
            type: 'array',
            maxItems: MAX_DEVICES,
            items: { type: 'string' },
            description: 'Preset ids, optionally id@Portrait, default phone to PC.',
          },
          target: { type: 'string', description: 'edit or client-N, default client-1 in a playtest, else edit.' },
          root: { type: 'string', description: 'GUI subtree to audit, default PlayerGui or StarterGui.' },
          min_touch_px: { type: 'number', minimum: 1, maximum: 400, default: 44, description: 'Smallest touch target side on touch devices.' },
          checks: {
            type: 'array',
            items: { type: 'string', enum: [...UI_AUDIT_CHECKS] },
            description: 'Checks to run, default all.',
          },
          limit: { type: 'number', minimum: 1, maximum: 200, default: 25, description: 'Findings listed per device and per summary list.' },
          instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
        },
      },
    },
  ],
  handlers: {
    ui_audit: (tools, body, context) => uiAudit(tools, body, body.instance_id as string | undefined, context?.signal),
  },
  instructions: [{
    tools: ['ui_audit'],
    text: 'Use ui_audit to catch offscreen, overlapping, clipped and unreadable GUI elements across device sizes before judging screenshots.',
  }],
  guide: `## GUI layout audit

- ui_audit switches the device simulator through each preset, measures the GUI in the viewport pixel space screenshots use, and then restores the device, orientation, resolution, density and scaling it found.
- It refuses to start while a custom device is simulated, because the simulator tools cannot switch back to one.
- A bad root or a missing PlayerGui fails before any device switch.
- Without devices it audits the smallest phone in portrait and landscape, the smallest tablet in landscape, and the desktop preset closest to 1080p.
- Pass preset ids from get_device_simulator_state, optionally suffixed with @Portrait, @LandscapeLeft or @LandscapeRight, and phones and tablets otherwise run in landscape.
- Other presets get no orientation. Studio put a desktop preset back in landscape after a portrait phone when checked live, and a warning flags one that stays portrait.
- It defaults to client-1 during a playtest, so GUIs that scripts build at runtime are included.
- In edit mode it reads StarterGui, which only holds GUIs that exist before any script runs, and a device that measured no elements says so in warnings.
- Without root it skips PlayerGui.TouchGui, the thumbstick and jump button Roblox's PlayerModule builds on touch devices.
- summary.everyDevice lists issues found on every device, which are layout bugs regardless of screen size, with rects and numbers measured on the device named in measuredOn.
- summary.someDevices lists responsive issues with the devices they appear on, and each device's findings carry those issues with rects as [x, y, w, h].
- offscreen and clipped fold descendants into the outermost reported element and count them in nested.
- A descendant clearly less visible than that element is reported on its own, so a hidden button on a barely overhanging panel still shows up.
- offscreen judges only the part ancestors' ClipsDescendants leave visible, so content parked inside a clipping frame is reported as clipped, not offscreen.
- Fully transparent containers and content inside ScrollingFrames are not checked for offscreen or clipping.
- Buttons and TextBoxes with Interactable off count as not interactive.
- overlap pairs interactive elements that share at least 10 percent of the smaller one's visible area, ignoring buttons nested inside buttons.
- top names the element that renders above by DisplayOrder and ZIndex, and invisible names a transparent one that may be swallowing clicks.
- small_text flags text rendered under ${MIN_TEXT_PX} px, and estimated marks TextScaled text whose size comes from TextBounds.
- small_touch only runs on phone and tablet presets, or on a preset of unknown form when the peer reports touch input.
- under_topbar flags interactive elements in the top bar band outside GuiService.TopbarInset, where Roblox's own buttons take the input.
- A device without topbarFree has no known free stretch, so every interactive element in the band is flagged there.
- overlap rects are the visible parts after clipping, while the other kinds report the element's full rect.
- Panels parked off screen on purpose for a tween show up as offscreen with onScreen 0, so check findings against intent.
- The audit complements screenshots rather than replacing them, so confirm surprising findings with capture_device_matrix.`,
};

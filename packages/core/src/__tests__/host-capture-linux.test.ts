import {
  captureLinuxStudioWindow,
  decodeXwd,
  parseXwininfoTree,
  pickStudioWindow,
} from '../host-capture-linux.js';
import { findWineStudioPluginsFolder } from '../wine-prefixes.js';

const TREE = `
xwininfo: Window id: 0x3d3 (the root window) (has no name)

  Root window id: 0x3d3 (the root window) (has no name)
  Parent window id: 0x0 (none)
     4 children:
     0x1a00007 "Combat - Roblox Studio": ("robloxstudiobeta.exe" "robloxstudiobeta.exe")  2560x1369+0+0  +0+0
        1 child:
        0x1a00009 "Combat - Roblox Studio": ("robloxstudiobeta.exe" "robloxstudiobeta.exe")  2544x1330+8+31  +8+31
     0x1a00011 "Roblox Studio": ("robloxstudiobeta.exe" "robloxstudiobeta.exe")  64x64+0+0  +0+0
     0x2200003 "Some \\"quoted\\" - Roblox Studio": ("firefox" "firefox")  1200x800+0+0  +0+0
     0x2400001 (has no name): ()  1x1+-1+-1  +-1+-1
`;

function xwd(width: number, height: number, pixels: number[], name = 'studio'): Buffer {
  const nameBytes = Buffer.from(`${name}\0`, 'latin1');
  const headerSize = 100 + nameBytes.length;
  const bytesPerLine = width * 4;
  const header = Buffer.alloc(100);
  const fields = [
    headerSize, 7, 2, 24, width, height, 0, 0, 32, 0, 32, 32, bytesPerLine, 4,
    0xff0000, 0x00ff00, 0x0000ff, 8, 256, 0, width, height, 0, 0, 0,
  ];
  fields.forEach((value, index) => header.writeUInt32BE(value >>> 0, index * 4));
  const image = Buffer.alloc(bytesPerLine * height);
  pixels.forEach((pixel, index) => image.writeUInt32LE(pixel >>> 0, index * 4));
  return Buffer.concat([header, nameBytes, image]);
}

describe('Linux X11 host capture', () => {
  test('parses xwininfo trees including unnamed and quoted titles', () => {
    const windows = parseXwininfoTree(TREE);
    expect(windows.map((window) => window.id)).toEqual([0x1a00007, 0x1a00009, 0x1a00011, 0x2200003, 0x2400001]);
    expect(windows[0]).toEqual({
      id: 0x1a00007, title: 'Combat - Roblox Studio', className: 'robloxstudiobeta.exe robloxstudiobeta.exe', width: 2560, height: 1369,
    });
    expect(windows[3].title).toBe('Some "quoted" - Roblox Studio');
    expect(windows[4].title).toBe('');
  });

  test('picks the outermost Studio window and ignores splash, other apps and decoys', () => {
    const windows = parseXwininfoTree(TREE);
    expect(pickStudioWindow(windows)).toMatchObject({ id: 0x1a00007 });
    expect(pickStudioWindow(windows, 'Combat')).toMatchObject({ id: 0x1a00007 });
    expect(pickStudioWindow(windows, 'Lobby')).toMatch(/no Roblox Studio X11 window matches/);
    expect(pickStudioWindow([])).toMatch(/no Roblox Studio X11 window/);
  });

  test('refuses to guess between two Studio places', () => {
    const windows = parseXwininfoTree(`${TREE}     0x1b00007 "Lobby - Roblox Studio": ("robloxstudiobeta.exe" "robloxstudiobeta.exe")  1920x1080+0+0  +0+0\n`);
    expect(pickStudioWindow(windows)).toMatch(/2 Roblox Studio windows match/);
    expect(pickStudioWindow(windows, 'Lobby')).toMatchObject({ id: 0x1b00007 });
  });

  test('decodes 32-bit LSB-first ZPixmap XWD into RGBA', () => {
    const decoded = decodeXwd(xwd(2, 1, [0x00ff00ff, 0x00102030]));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect([...decoded.rgba]).toEqual([255, 0, 255, 255, 0x10, 0x20, 0x30, 255]);
  });

  test('rejects truncated or unsupported XWD data', () => {
    expect(() => decodeXwd(Buffer.alloc(10))).toThrow(/shorter than its header/);
    expect(() => decodeXwd(xwd(4, 4, [1]).subarray(0, 140))).toThrow(/truncated/);
  });

  test('captures through xwininfo, xprop and xwd and keeps the window identity', async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === 'xwininfo') return Buffer.from(TREE);
      if (file === 'xprop') return Buffer.from('_NET_WM_PID(CARDINAL) = 4242\n');
      if (file === 'xwd') return xwd(1, 1, [0x00abcdef]);
      throw new Error(`unexpected ${file}`);
    };
    const result = await captureLinuxStudioWindow('Combat', undefined, run);
    expect(result).toMatchObject({
      ok: true,
      capture: {
        width: 1, height: 1, title: 'Combat - Roblox Studio',
        identity: { windowId: 0x1a00007, processId: 4242, bundleIdentifier: 'robloxstudiobeta.exe' },
      },
    });
    expect(calls.at(-1)).toEqual(['xwd', '-id', '0x1a00007', '-silent']);

    const moved = await captureLinuxStudioWindow(undefined, { windowId: 0x1a00007, processId: 1, bundleIdentifier: 'robloxstudiobeta.exe' }, run);
    expect(moved).toEqual({ ok: false, error: 'the Studio window now belongs to a different process' });
    const gone = await captureLinuxStudioWindow(undefined, { windowId: 0x999, processId: 4242, bundleIdentifier: 'robloxstudiobeta.exe' }, run);
    expect(gone).toEqual({ ok: false, error: 'the previously captured Studio window is gone' });
  });

  test('reports a missing X11 tool instead of throwing', async () => {
    const result = await captureLinuxStudioWindow(undefined, undefined, async () => {
      throw new Error('xwininfo is not installed; Linux host capture needs xwininfo, xprop and xwd on PATH');
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('xwininfo is not installed') });
  });
});

describe('Wine Studio plugin folder discovery', () => {
  const home = '/home/dev';
  const flatpakUsers = `${home}/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users`;

  test('finds the Flatpak Vinegar prefix and prefers the Unix user profile', () => {
    const existing = new Set([
      flatpakUsers,
      `${flatpakUsers}/other/AppData/Local/Roblox`,
      `${flatpakUsers}/dev/AppData/Local/Roblox`,
    ]);
    const folder = findWineStudioPluginsFolder(
      { USER: 'dev' }, home, (path) => existing.has(path), () => ['Public', 'other', 'dev'],
    );
    expect(folder).toBe(`${flatpakUsers}/dev/AppData/Local/Roblox/Plugins`);
  });

  test('checks WINEPREFIX and native Vinegar before Flatpak', () => {
    const native = '/data/vinegar/prefixes/studio/drive_c/users';
    const existing = new Set([native, `${native}/dev/AppData/Local/Roblox`, flatpakUsers, `${flatpakUsers}/dev/AppData/Local/Roblox`]);
    const folder = findWineStudioPluginsFolder(
      { USER: 'dev', XDG_DATA_HOME: '/data' }, home, (path) => existing.has(path), () => ['dev'],
    );
    expect(folder).toBe(`${native}/dev/AppData/Local/Roblox/Plugins`);
  });

  test('returns nothing when no prefix has a Roblox profile', () => {
    expect(findWineStudioPluginsFolder({}, home, () => false, () => [])).toBeUndefined();
  });
});

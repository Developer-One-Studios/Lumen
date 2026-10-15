import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourcemapResolver } from '../sourcemap.js';
import { getStudioLogsFolder, listStudioLogFiles, parseStudioLog, readStudioPlaytests } from '../studio-logs.js';
import { readPlaytestLogs } from '../tools/fork/playtest-logs.js';

// Shaped like a real Studio log: header lines without a timestamp, engine noise, and two playtests.
const LOG = [
  '[FLog::Output] All use of Roblox services must comply with Roblox\'s Terms of Use.',
  'Command line:',
  '2026-10-15T17:54:47.291Z,7.291922,01f0,6 [telemetryLog] placeid: 130944371011766',
  '2026-10-15T17:54:47.298Z,7.298986,020c,6,Info [FLog::DMListenerBridge] registerDataModel dm=0x8ae454d0, gst=StudioGameStateType_Edit, dmId=2, isOriginalDM=true',
  '2026-10-15T17:55:00.000Z,20.000000,0120,6,Info [FLog::CreatorOutput] edit-time output, outside any playtest',
  '2026-10-15T17:56:56.781Z,136.781815,01fc,6,Info [FLog::DMListenerBridge] registerDataModel dm=0x18ca424d0, gst=StudioGameStateType_PlayServer, dmId=3, isOriginalDM=false',
  '2026-10-15T17:56:56.788Z,136.788803,01ec,6,Info [FLog::DMListenerBridge] registerDataModel dm=0x1bb4f48d0, gst=StudioGameStateType_PlayClient, dmId=4, isOriginalDM=false',
  '2026-10-15T17:57:00.148Z,140.148331,01e8,6 [FLog::Output] Flag UnifyModelPackagePublish3 referenced from Lua isn\'t defined in C++ code',
  '2026-10-15T17:57:00.207Z,140.207382,012c,6,Info [FLog::CreatorOutput] [BalanceService] loaded published overrides v5 (boot)',
  '2026-10-15T17:57:00.269Z,140.269287,0128,6,Warning [FLog::CreatorWarning] Warning: [ClientData] No player data available for watching',
  '2026-10-15T17:57:00.641Z,140.641708,01f0,6,Error [FLog::CreatorError] Error: ServerScriptService.Main:12: attempt to index nil',
  '2026-10-15T17:57:00.641Z,140.641708,01f0,6,Info [FLog::CreatorOutput] Info: Stack Begin',
  '2026-10-15T17:57:00.641Z,140.641708,01f0,6,Info [FLog::CreatorOutput] Info: Script \'ServerScriptService.Main\', Line 12',
  '2026-10-15T17:57:00.641Z,140.641708,01f0,6,Info [FLog::CreatorOutput] Info: Stack End',
  '2026-10-15T17:57:01.000Z,141.000000,012c,6,Info [FLog::CreatorOutput] first line of a print',
  'second line of the same print',
  '2026-10-15T17:57:01.500Z,141.500000,0718,6,Error [DFLog::AssetProvider] AssetResolutionWorkflow failed!! for placeId 999',
  '2026-10-15T17:58:19.114Z,219.114288,012c,6,Info [FLog::DMListenerBridge] deregisterDataModelForDMId dm=0x1bb4f48d0, gst=StudioGameStateType_PlayClient, dmId=4',
  '2026-10-15T17:58:20.000Z,220.000000,0128,6,Info [FLog::CreatorOutput] server shutting down',
  '2026-10-15T17:58:21.063Z,221.063110,0128,6,Info [FLog::DMListenerBridge] deregisterDataModelForDMId dm=0x18ca424d0, gst=StudioGameStateType_PlayServer, dmId=3',
  '2026-10-15T17:58:30.000Z,230.000000,0128,6,Info [FLog::CreatorOutput] after the playtest',
  '2026-10-15T17:59:51.562Z,311.562531,01f8,6,Info [FLog::DMListenerBridge] registerDataModel dm=0x25ecbccd0, gst=StudioGameStateType_PlayServer, dmId=5, isOriginalDM=false',
  '2026-10-15T17:59:52.000Z,312.000000,01f8,6,Error [FLog::CreatorError] Error: Failed to load sound rbxassetid://1: Asset has not been reviewed',
  '2026-10-15T17:59:53.000Z,313.000000,01f8,6,Info [FLog::CreatorOutput] still running',
].join('\n');

function logFolder(files: Record<string, string>): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-logs-'));
  let time = Date.now() / 1000 - 100;
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(folder, name);
    fs.writeFileSync(file, contents);
    fs.utimesSync(file, time, time);
    time += 10;
  }
  return folder;
}

const plain = { annotateText: (text: string) => text } as unknown as SourcemapResolver;

describe('Studio log parsing', () => {
  test('splits playtests at play DataModel boundaries and keeps only script output inside them', () => {
    const playtests = parseStudioLog(LOG, 'a.log');
    expect(playtests).toHaveLength(2);
    const [first, second] = playtests;
    expect(first).toMatchObject({ file: 'a.log', placeId: 130944371011766, clients: 1 });
    expect(first.startedAt).toBe(Date.parse('2026-10-15T17:56:56.781Z') / 1000);
    expect(first.endedAt).toBe(Date.parse('2026-10-15T17:58:21.063Z') / 1000);
    expect(first.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['OUT', '[BalanceService] loaded published overrides v5 (boot)'],
      ['WARN', '[ClientData] No player data available for watching'],
      ['ERR', 'ServerScriptService.Main:12: attempt to index nil'],
      ['INFO', 'Stack Begin'],
      ['INFO', 'Script \'ServerScriptService.Main\', Line 12'],
      ['INFO', 'Stack End'],
      ['OUT', 'first line of a print\nsecond line of the same print'],
      ['OUT', 'server shutting down'],
    ]);
    expect(second.endedAt).toBeUndefined();
    expect(second.clients).toBe(0);
    expect(second.entries.map((entry) => entry.message)).toEqual(['Failed to load sound rbxassetid://1: Asset has not been reviewed', 'still running']);
  });

  test('a log with no playtest yields none', () => {
    expect(parseStudioLog(LOG.split('\n').slice(0, 5).join('\n'), 'b.log')).toEqual([]);
  });

  test('only Studio log files count, newest first', () => {
    const folder = logFolder({ 'x_Studio_A_last.log': '', 'notes.txt': '', 'y_Studio_B_last.log': '', 'z_Player_C_last.log': '' });
    expect(listStudioLogFiles(folder, 5).map((file) => path.basename(file))).toEqual(['y_Studio_B_last.log', 'x_Studio_A_last.log']);
  });

  test('playtests from several launches are merged latest first', () => {
    const later = LOG.replace(/2026-10-15T17/g, '2026-10-15T19');
    const folder = logFolder({ 'one_Studio_A_last.log': LOG, 'two_Studio_B_last.log': later, 'idle_Studio_C_last.log': 'no playtests here' });
    const playtests = readStudioPlaytests(folder);
    expect(playtests.map((playtest) => playtest.file)).toEqual(['two_Studio_B_last.log', 'two_Studio_B_last.log', 'one_Studio_A_last.log', 'one_Studio_A_last.log']);
  });

  test('ROBLOX_STUDIO_LOG_DIR overrides the folder', () => {
    expect(getStudioLogsFolder({ ROBLOX_STUDIO_LOG_DIR: '/some/logs' })).toBe('/some/logs');
  });
});

describe('get_playtest_logs', () => {
  const env = () => ({ ROBLOX_STUDIO_LOG_DIR: logFolder({ 'one_Studio_A_last.log': LOG }) });
  const read = (body: Record<string, unknown>, environment: NodeJS.ProcessEnv) =>
    JSON.parse(readPlaytestLogs(body, environment, plain).content[0].text as string);

  test('lists playtests latest first with their counts', () => {
    const result = read({ list: true }, env());
    expect(result.playtests).toHaveLength(2);
    expect(result.playtests[0]).toMatchObject({ playtest: 1, running: true, clients: 0, lines: 2, errors: 1, warnings: 0 });
    expect(result.playtests[1]).toMatchObject({ playtest: 2, placeId: 130944371011766, durationS: 84.28, clients: 1, lines: 8, errors: 1, warnings: 1 });
  });

  test('reads one playtest with times from its start, filtered and tailed', () => {
    const environment = env();
    const all = read({ playtest: 2 }, environment);
    expect(all.matched).toBe(8);
    expect(all.entries[0]).toEqual({ t: 3.43, level: 'OUT', message: '[BalanceService] loaded published overrides v5 (boot)' });
    expect(all.note).toContain('no server or client label');

    const issues = read({ playtest: 2, level: 'issues' }, environment);
    expect(issues.entries.map((entry: { level: string }) => entry.level)).toEqual(['WARN', 'ERR']);

    const filtered = read({ playtest: 2, filter: 'STACK', tail: 1 }, environment);
    expect(filtered).toMatchObject({ matched: 2, shown: 1 });
    expect(filtered.entries[0].message).toBe('Stack End');

    const excluded = read({ playtest: 1, exclude: ['failed to load sound'] }, environment);
    expect(excluded.entries.map((entry: { message: string }) => entry.message)).toEqual(['still running']);
  });

  test('place_id narrows the playtests, and an index past the end says how many there are', () => {
    const environment = env();
    expect(read({ list: true, place_id: 130944371011766 }, environment).playtests).toHaveLength(1);
    expect(() => readPlaytestLogs({ playtest: 3 }, environment, plain)).toThrow('only 2 playtests');
  });

  test('an empty folder reports no playtests instead of failing', () => {
    const result = read({}, { ROBLOX_STUDIO_LOG_DIR: logFolder({}) });
    expect(result.playtests).toEqual([]);
  });
});

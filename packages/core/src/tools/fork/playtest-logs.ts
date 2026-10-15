import type { SourcemapResolver } from '../../sourcemap.js';
import { getStudioLogsFolder, readStudioPlaytests, type StudioLogEntry, type StudioPlaytest } from '../../studio-logs.js';
import { clamp, sourcemaps, toolText } from '../fork-tools.js';
import { isExcluded, parseExcludes } from './diagnostics.js';
import type { ForkFeature } from './feature.js';

const MAX_MESSAGE_CHARS = 2000;
const MAX_LISTED = 20;
const NOTE = 'Read from Studio\'s own log file. Lines carry no server or client label, and edit-time plugin output during the playtest is included.';

type Level = 'all' | 'issues' | 'errors';

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function summary(playtest: StudioPlaytest, index: number) {
  return {
    playtest: index,
    ...(playtest.placeId !== undefined ? { placeId: playtest.placeId } : {}),
    startedAt: iso(playtest.startedAt),
    ...(playtest.endedAt !== undefined ? { endedAt: iso(playtest.endedAt), durationS: round(playtest.endedAt - playtest.startedAt) } : { running: true }),
    clients: playtest.clients,
    lines: playtest.entries.length,
    errors: playtest.entries.filter((entry) => entry.level === 'ERR').length,
    warnings: playtest.entries.filter((entry) => entry.level === 'WARN').length,
    file: playtest.file,
  };
}

function wantedLevel(level: Level, entry: StudioLogEntry): boolean {
  if (level === 'errors') return entry.level === 'ERR';
  if (level === 'issues') return entry.level === 'ERR' || entry.level === 'WARN';
  return true;
}

export function readPlaytestLogs(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, resolver: SourcemapResolver = sourcemaps) {
  const level = (body.level ?? 'all') as Level;
  if (level !== 'all' && level !== 'issues' && level !== 'errors') throw new Error('level must be all, issues or errors.');
  if (body.filter !== undefined && typeof body.filter !== 'string') throw new Error('filter must be a string.');
  if (body.place_id !== undefined && (typeof body.place_id !== 'number' || !Number.isInteger(body.place_id))) throw new Error('place_id must be a whole number.');
  const excludes = parseExcludes(body.exclude);
  const tail = clamp(body.tail, 200, 1, 2000);

  const folder = getStudioLogsFolder(env);
  if (!folder) throw new Error('Studio\'s log folder was not found. Set ROBLOX_STUDIO_LOG_DIR to the folder Studio writes its logs to.');
  const all = readStudioPlaytests(folder);
  const playtests = body.place_id === undefined ? all : all.filter((playtest) => playtest.placeId === body.place_id);
  if (playtests.length === 0) {
    return toolText({ folder, playtests: [], note: 'No playtest was found in Studio\'s recent log files.' });
  }

  if (body.list === true) {
    return toolText({
      folder,
      playtests: playtests.slice(0, MAX_LISTED).map((playtest, i) => summary(playtest, i + 1)),
      ...(playtests.length > MAX_LISTED ? { truncated: true, total: playtests.length } : {}),
    });
  }

  const index = clamp(body.playtest, 1, 1, Number.MAX_SAFE_INTEGER);
  const playtest = playtests[index - 1];
  if (!playtest) throw new Error(`There are only ${playtests.length} playtests in Studio's recent log files.`);

  const filter = typeof body.filter === 'string' && body.filter !== '' ? body.filter.toLowerCase() : undefined;
  const matched = playtest.entries.filter((entry) =>
    wantedLevel(level, entry)
    && (filter === undefined || entry.message.toLowerCase().includes(filter))
    && !isExcluded(entry.message, excludes));
  const shown = matched.slice(-tail);
  return toolText({
    ...summary(playtest, index),
    matched: matched.length,
    shown: shown.length,
    entries: shown.map((entry) => ({
      t: round(entry.ts - playtest.startedAt),
      level: entry.level,
      message: resolver.annotateText(entry.message.length > MAX_MESSAGE_CHARS ? `${entry.message.slice(0, MAX_MESSAGE_CHARS)}...` : entry.message),
    })),
    note: NOTE,
  });
}

export const playtestLogsFeature: ForkFeature = {
  name: 'playtest-logs',
  studioAgnostic: ['get_playtest_logs'],
  definitions: [
    {
      name: 'get_playtest_logs',
      category: 'read',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Use to read script output of a playtest that already ended, from Studio\'s own log files.',
      inputSchema: {
        type: 'object',
        properties: {
          playtest: { type: 'integer', minimum: 1, default: 1, description: '1 is the latest playtest, 2 the one before, and so on.' },
          list: { type: 'boolean', description: 'List recent playtests instead of reading one.' },
          level: { type: 'string', enum: ['all', 'issues', 'errors'], default: 'all', description: 'all, issues (errors and warnings) or errors.' },
          filter: { type: 'string', description: 'Only lines containing this text, ignoring case.' },
          exclude: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Skip lines containing any of these texts, ignoring case.' },
          tail: { type: 'integer', minimum: 1, maximum: 2000, default: 200, description: 'Last N matching lines, default 200.' },
          place_id: { type: 'integer', description: 'Only playtests of this place.' },
        },
      },
    },
  ],
  handlers: {
    get_playtest_logs: async (_tools, body) => readPlaytestLogs(body),
  },
  instructions: [
    {
      tools: ['get_playtest_logs'],
      text: 'Use get_playtest_logs for output from a playtest that already ended, since get_runtime_logs only reaches running peers.',
    },
  ],
  guide: `## Logs of past playtests

- get_runtime_logs and get_errors read the plugin's buffers inside each running DataModel, which end with the playtest. get_playtest_logs reads Studio's own log files, which keep every playtest's output after it ends, including playtests the user ran.
- list=true shows recent playtests, latest first, with place, start and end times, client count and line, error and warning counts. A playtest still running has running: true.
- Without list it returns the last tail lines of one playtest, playtest=1 being the latest. Each line has t, seconds since the playtest started, its level and the message.
- level=issues keeps errors and warnings and level=errors only errors. filter keeps lines containing a text and exclude drops lines containing any of several, both ignoring case.
- Stack traces show as INFO lines from Stack Begin to Stack End after the error they belong to.
- Lines carry no server or client label, and output from the edit DataModel's plugins during the playtest is mixed in.
- It reads the newest few Studio log files, so playtests from older Studio launches drop out. ROBLOX_STUDIO_LOG_DIR overrides the folder.
`,
};

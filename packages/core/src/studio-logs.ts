// Studio writes every launch's output to its own log file, playtest server and clients included, and keeps the
// file after the playtest ends. The plugin's runtime log buffers die with the playtest's DataModels, so these files
// are the only record of a playtest that is over. Lines carry no server or client label.
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { dirname, join as posixJoin } from 'path/posix';
import { getWindowsUserLocalAppData, isWSL } from './install-plugin-helpers.js';
import { findWineStudioPluginsFolder } from './wine-prefixes.js';

export type StudioLogLevel = 'OUT' | 'INFO' | 'WARN' | 'ERR';

export interface StudioLogEntry {
  /** Unix seconds, like runtime log entries. */
  ts: number;
  level: StudioLogLevel;
  message: string;
}

export interface StudioPlaytest {
  file: string;
  placeId?: number;
  startedAt: number;
  /** Unset while the playtest is still running. */
  endedAt?: number;
  clients: number;
  entries: StudioLogEntry[];
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z),/;
const LINE = /^[^,]+,[^,]*,[0-9a-fA-F]+,\d+(?:,\w+)? \[(D?FLog::\w+)\] ?(.*)$/;
const REGISTER = /\bregisterDataModel dm=\S+, gst=StudioGameStateType_(\w+), dmId=(\d+)/;
const DEREGISTER = /\bderegisterDataModelForDMId dm=\S+, gst=StudioGameStateType_(\w+), dmId=(\d+)/;
const PLACE_ID = /\bplace[iI]d:? (\d+)/;
const LOG_FILE = /_Studio_.*\.log$/i;

// Output, warnings and errors from scripts. Studio prefixes the last two, and TestService and stack lines, with their level.
const CHANNELS: Record<string, { level: StudioLogLevel; prefix: string }> = {
  'FLog::CreatorOutput': { level: 'OUT', prefix: 'Info: ' },
  'FLog::CreatorWarning': { level: 'WARN', prefix: 'Warning: ' },
  'FLog::CreatorError': { level: 'ERR', prefix: 'Error: ' },
};

/** Where Studio writes its logs on this machine, or undefined when it cannot be found. */
export function getStudioLogsFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.ROBLOX_STUDIO_LOG_DIR?.trim();
  if (override) return override;
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Roblox', 'logs');
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Logs', 'Roblox');
  if (isWSL()) {
    const localAppData = getWindowsUserLocalAppData();
    return localAppData ? posixJoin(localAppData.linuxPath, 'Roblox', 'logs') : undefined;
  }
  // Studio on native Linux runs in a Wine prefix, with its logs beside its Plugins folder.
  const plugins = findWineStudioPluginsFolder(env);
  return plugins ? posixJoin(dirname(plugins), 'logs') : undefined;
}

/** The newest Studio log files first. */
export function listStudioLogFiles(folder: string, max: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => LOG_FILE.test(name))
    .map((name) => {
      const file = path.join(folder, name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return { file, mtime: stat?.isFile() ? stat.mtimeMs : -1 };
    })
    .filter((entry) => entry.mtime >= 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((entry) => entry.file);
}

/**
 * The playtests in one Studio log. A playtest runs from its first play DataModel (server or client) registering
 * until the last one deregisters, and holds the script output logged in between. Output from the edit DataModel's
 * plugins in that window is in there too, since nothing in a line tells the DataModels apart.
 */
export function parseStudioLog(text: string, file: string): StudioPlaytest[] {
  const playtests: StudioPlaytest[] = [];
  const live = new Set<string>();
  let current: StudioPlaytest | undefined;
  let placeId: number | undefined;
  // A message with newlines continues on lines without the timestamp prefix.
  let continued: StudioLogEntry | undefined;

  for (const line of text.split(/\r?\n/)) {
    const stamp = STAMP.exec(line);
    if (!stamp) {
      if (continued && line !== '') continued.message += `\n${line}`;
      continue;
    }
    continued = undefined;
    const ts = Date.parse(stamp[1]) / 1000;
    const match = LINE.exec(line);
    const channel = match ? match[1] : '';
    const rawMessage = match ? match[2] : line;

    const register = REGISTER.exec(rawMessage);
    if (register && register[1].startsWith('Play')) {
      if (!current) {
        current = { file, ...(placeId !== undefined ? { placeId } : {}), startedAt: ts, clients: 0, entries: [] };
        playtests.push(current);
      }
      if (register[1] === 'PlayClient') current.clients++;
      live.add(register[2]);
      continue;
    }
    const deregister = DEREGISTER.exec(rawMessage);
    if (deregister && deregister[1].startsWith('Play')) {
      live.delete(deregister[2]);
      if (current && live.size === 0) {
        current.endedAt = ts;
        current = undefined;
      }
      continue;
    }
    if (!CHANNELS[channel]) {
      const place = PLACE_ID.exec(rawMessage);
      if (place && Number(place[1]) > 0) placeId = Number(place[1]);
    }

    const kind = CHANNELS[channel];
    if (!kind || !current) continue;
    let level = kind.level;
    let message = rawMessage;
    if (message.startsWith(kind.prefix)) {
      message = message.slice(kind.prefix.length);
      if (level === 'OUT') level = 'INFO';
    }
    continued = { ts, level, message };
    current.entries.push(continued);
  }
  return playtests;
}

/** Every playtest in the newest log files, the latest first. */
export function readStudioPlaytests(folder: string, maxFiles = 6): StudioPlaytest[] {
  const playtests: StudioPlaytest[] = [];
  for (const file of listStudioLogFiles(folder, maxFiles)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Launches that never playtested are skipped without parsing.
    if (!text.includes('StudioGameStateType_Play')) continue;
    playtests.push(...parseStudioLog(text, path.basename(file)));
  }
  return playtests.sort((a, b) => b.startedAt - a.startedAt);
}

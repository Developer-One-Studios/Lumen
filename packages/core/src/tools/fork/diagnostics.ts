import type { SourcemapResolver } from '../../sourcemap.js';
import { clamp, sourcemaps, toolText, type ForkHost, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature } from './feature.js';

const RUNTIME_LOGS = '/api/get-runtime-logs';
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_LINES = 12;

type Level = 'ERR' | 'WARN';
type LogEntry = { seq?: unknown; ts?: unknown; level?: unknown; message?: unknown };

export interface Occurrence {
  level: Level;
  message: string;
  stack: string[];
  ts: number;
  role: string;
}

// Roblox logs a stack as separate entries after the error: Stack Begin, Script '<path>', Line N per frame, Stack End.
const FRAME = /^Script '.*', Line \d+/;
// Frames folded into one message, from debug.traceback or a rethrown error.
const INLINE_FRAME = /^(?:Script '.*', Line \d+.*|Stack Begin|Stack End|stack traceback:|\S.*:\d+(?: function .+)?)$/;
const MARKERS = new Set(['Stack Begin', 'Stack End', 'stack traceback:']);

// Where the previous call left each peer, so a bare call returns only what is new however the Studio was addressed.
const lastSeqs = new WeakMap<ForkHost, Map<string, number>>();
// Every playtest brings new peer IDs, so the oldest are forgotten past this many.
const REMEMBERED_PEERS = 256;

/** Splits trailing stack frames off a message so repeats of one error group together. */
export function splitStack(message: string): { message: string; stack: string[] } {
  const lines = message.split('\n');
  let cut = lines.length;
  while (cut > 1 && (lines[cut - 1].trim() === '' || INLINE_FRAME.test(lines[cut - 1].trim()))) cut--;
  const stack = lines.slice(cut).map((line) => line.trim()).filter((line) => line !== '' && !MARKERS.has(line));
  return { message: (stack.length > 0 ? lines.slice(0, cut) : lines).join('\n').trimEnd(), stack };
}

/** Errors and warnings in one peer's log, each with the stack entries Roblox printed after it. */
export function collectOccurrences(entries: LogEntry[], role: string): Occurrence[] {
  const found: Occurrence[] = [];
  let last: Occurrence | undefined;
  let frames: string[] | undefined;
  let follows = false;
  const attach = (lines: string[]) => {
    if (last && last.stack.length === 0) last.stack = lines;
  };
  for (const entry of entries) {
    const text = typeof entry.message === 'string' ? entry.message : '';
    const line = text.trim();
    const issue = entry.level === 'ERR' || entry.level === 'WARN';
    if (line === 'Stack Begin') {
      frames = [];
      continue;
    }
    if (line === 'Stack End') {
      if (frames) attach(frames);
      frames = undefined;
      follows = false;
      continue;
    }
    if (frames) {
      // A Stack End lost to the ring buffer must not swallow the next error.
      if (!issue || FRAME.test(line)) {
        frames.push(line);
        continue;
      }
      attach(frames);
      frames = undefined;
    }
    if (issue) {
      const split = splitStack(text);
      last = { level: entry.level as Level, message: split.message, stack: split.stack, ts: typeof entry.ts === 'number' ? entry.ts : 0, role };
      found.push(last);
      follows = true;
    } else if (follows && last && FRAME.test(line)) {
      last.stack.push(line);
    } else {
      follows = false;
    }
  }
  if (frames) attach(frames);
  return found;
}

function roleRank(role: string): number {
  if (role === 'edit') return 0;
  if (role === 'server') return 1;
  const client = /^client-(\d+)$/.exec(role);
  return client ? 2 + Number(client[1]) : Number.MAX_SAFE_INTEGER;
}

function encodeCursor(peers: Record<string, number>): string {
  return Buffer.from(JSON.stringify({ v: 1, peers })).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, number> {
  const invalid = () => new Error('since must be a cursor returned by an earlier get_errors call, or "all".');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!decoded || typeof decoded !== 'object') throw invalid();
  const { v, peers } = decoded as { v?: unknown; peers?: unknown };
  if (v !== 1 || !peers || typeof peers !== 'object' || Array.isArray(peers)) throw invalid();
  const parsed: Record<string, number> = {};
  for (const [peerId, seq] of Object.entries(peers)) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw invalid();
    parsed[peerId] = seq;
  }
  return parsed;
}

type PeerRead = { peer: PeerTarget; entries: LogEntry[]; nextSince: number; lost: number } | { peer: PeerTarget; error: string };

async function readPeer(host: ForkHost, peer: PeerTarget, prior: number | undefined): Promise<PeerRead> {
  const query = async (since: number | undefined) => {
    const reply = await host.requestPeer(RUNTIME_LOGS, since === undefined ? {} : { since }, peer.peerId, 15_000);
    const record = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
    if (typeof record.error === 'string') throw new Error(record.error);
    if (!Array.isArray(record.entries) || typeof record.nextSince !== 'number') throw new Error('Studio returned an invalid log buffer.');
    return { entries: record.entries as LogEntry[], nextSince: record.nextSince };
  };
  try {
    let since = prior;
    let reply = await query(since);
    // A reloaded plugin restarts its sequence, which would hide every new line behind the old cursor.
    if (since !== undefined && reply.nextSince < since) {
      since = undefined;
      reply = await query(since);
    }
    const firstSeq = reply.entries[0]?.seq;
    const lost = since !== undefined && typeof firstSeq === 'number' ? Math.max(0, firstSeq - since - 1) : 0;
    return { peer, entries: reply.entries, nextSince: reply.nextSince, lost };
  } catch (error) {
    return { peer, error: error instanceof Error ? error.message : String(error) };
  }
}

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text;
}

export async function getErrors(
  host: ForkHost,
  instanceId: string | undefined,
  body: Record<string, unknown>,
  resolver: SourcemapResolver = sourcemaps,
) {
  const level = body.level ?? 'errors';
  if (level !== 'errors' && level !== 'warnings' && level !== 'both') throw new Error('level must be errors, warnings or both.');
  const limit = clamp(body.limit, 20, 1, 100);
  if (body.since !== undefined && typeof body.since !== 'string') throw new Error('since must be a cursor string or "all".');
  const cursor = body.since === undefined || body.since === 'all' ? undefined : decodeCursor(body.since);

  const peers = [...await host.peerTargets('all', instanceId)].sort((a, b) => roleRank(a.role) - roleRank(b.role));
  const remembered = lastSeqs.get(host) ?? new Map<string, number>();
  lastSeqs.set(host, remembered);
  const known = peers.filter((peer) => remembered.has(peer.peerId));
  const from = cursor ? 'cursor' : body.since === undefined && known.length > 0 ? 'last_call' : 'start';
  const prior: Record<string, number> = cursor
    ?? (from === 'last_call' ? Object.fromEntries(known.map((peer) => [peer.peerId, remembered.get(peer.peerId) as number])) : {});
  const reads = await Promise.all(peers.map((peer) => readPeer(host, peer, prior[peer.peerId])));

  const next: Record<string, number> = {};
  const occurrences: Occurrence[] = [];
  const lost: Record<string, number> = {};
  const peerErrors: Array<{ peer: string; error: string }> = [];
  for (const read of reads) {
    if ('error' in read) {
      peerErrors.push({ peer: read.peer.role, error: read.error });
      if (prior[read.peer.peerId] !== undefined) next[read.peer.peerId] = prior[read.peer.peerId];
      continue;
    }
    next[read.peer.peerId] = read.nextSince;
    // Reinserted so the map stays in read order and eviction drops the stalest peers.
    remembered.delete(read.peer.peerId);
    remembered.set(read.peer.peerId, read.nextSince);
    if (read.lost > 0) lost[read.peer.role] = read.lost;
    occurrences.push(...collectOccurrences(read.entries, read.peer.role));
  }
  for (const peerId of remembered.keys()) {
    if (remembered.size <= REMEMBERED_PEERS) break;
    remembered.delete(peerId);
  }

  const wanted = (occurrence: Occurrence) =>
    level === 'both' || (level === 'errors' ? occurrence.level === 'ERR' : occurrence.level === 'WARN');
  type Group = { first: Occurrence; count: number; peers: Set<string>; lastTs: number; stack: string[]; stacks: Set<string> };
  const groups = new Map<string, Group>();
  for (const occurrence of occurrences.sort((a, b) => a.ts - b.ts)) {
    if (!wanted(occurrence)) continue;
    const key = `${occurrence.level}\n${occurrence.message}`;
    let group = groups.get(key);
    if (!group) {
      group = { first: occurrence, count: 0, peers: new Set(), lastTs: occurrence.ts, stack: [], stacks: new Set() };
      groups.set(key, group);
    }
    group.count++;
    group.peers.add(occurrence.role);
    group.lastTs = occurrence.ts;
    if (occurrence.stack.length > 0) {
      if (group.stack.length === 0) group.stack = occurrence.stack;
      group.stacks.add(occurrence.stack.join('\n'));
    }
  }

  const listed = [...groups.values()].slice(0, limit).map((group) => {
    const stack = group.stack.slice(0, MAX_STACK_LINES).map((line) => resolver.annotateText(clip(line)));
    if (group.stack.length > MAX_STACK_LINES) stack.push(`... ${group.stack.length - MAX_STACK_LINES} more frames`);
    return {
      level: group.first.level === 'ERR' ? 'error' : 'warning',
      message: resolver.annotateText(clip(group.first.message)),
      count: group.count,
      peers: [...group.peers].sort((a, b) => roleRank(a) - roleRank(b)),
      firstTs: group.first.ts,
      lastTs: group.lastTs,
      ...(stack.length > 0 ? { stack } : {}),
      ...(group.stacks.size > 1 ? { otherStacks: group.stacks.size - 1 } : {}),
    };
  });
  return toolText({
    from,
    cursor: encodeCursor(next),
    peers: reads.filter((read) => !('error' in read)).map((read) => read.peer.role),
    totals: {
      errors: occurrences.filter((occurrence) => occurrence.level === 'ERR').length,
      warnings: occurrences.filter((occurrence) => occurrence.level === 'WARN').length,
    },
    groups: listed,
    ...(groups.size > limit ? { truncated: true, omittedGroups: groups.size - limit } : {}),
    ...(Object.keys(lost).length > 0 ? { lost } : {}),
    ...(peerErrors.length > 0 ? { peerErrors } : {}),
  });
}

export const diagnosticsFeature: ForkFeature = {
  name: 'diagnostics',
  definitions: [
    {
      name: 'get_errors',
      category: 'read',
      // Not idempotent: a bare call advances the remembered cursor, so a retry returns nothing new.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: 'Use to get a deduplicated digest of errors and warnings from every peer since the last call.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Cursor from an earlier call, or all. Defaults to the last call.' },
          level: {
            type: 'string',
            enum: ['errors', 'warnings', 'both'],
            default: 'errors',
            description: 'Messages to include, errors by default.',
          },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20, description: 'Most distinct messages to return, oldest first.' },
          instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
        },
      },
    },
  ],
  handlers: {
    get_errors: (tools, body) => getErrors(tools.forkHost, body.instance_id as string | undefined, body),
  },
  instructions: [
    {
      tools: ['get_errors'],
      text: 'After a playtest or a script change, call get_errors for a grouped digest of new errors on every peer before reading raw logs.',
    },
  ],
  guide: `
## Errors and whitespace-tolerant edits

- get_errors groups ERR and WARN output from the edit DataModel, the playtest server, and every client by message text, with a count, the peers that logged it, first and last timestamps, and the stack Roblox printed after it.
- Without since it returns only what each peer logged after the previous get_errors call read it, with or without instance_id, and a peer's first call reads its whole buffer.
- A retried bare call returns nothing new, so keep the returned cursor and pass it as since to read again from that point, or pass since=all to read every buffer from the start.
- Groups are ordered by first occurrence, so the first one is usually the root cause and later ones are often fallout.
- level=both adds warnings such as infinite yield notices, and totals counts both levels either way.
- Each peer keeps only about 64 KB of output, so a noisy playtest drops old lines, and lost says how many each peer dropped between calls.
- A new playtest has new peers, so its server and clients are read from the start of their buffers.
- Messages and stack frames get [file:line] when a Rojo sourcemap is found.
- multi_edit and edit_script_lines retry an old_string that is not found exactly while ignoring whitespace drift.
- Runs of spaces and tabs compare as one space, and whitespace at line ends and CR are ignored, so indentation must be present where the script has it but its width and tabs versus spaces do not matter.
- A space or tab at the end of old_string still needs whitespace or a line end after the match, so it never cuts into a longer word.
- A unique match is replaced in the original text and reported with fuzzy: true and its line range, and new_string is inserted exactly as given.
- With line_range, edit_script_lines accepts only a match that starts on that line, and a miss quotes that line and names the lines where the text does match.
- multi_edit lists each fuzzy edit in fuzzyEdits with its match count and up to 10 line ranges, counted in the script as it stood when that edit ran, so later edits in the batch can shift them.
- When nothing or several places match, the error quotes the closest or matching lines with line numbers, so copy the exact text from there and retry.
`,
};

import type { RobloxStudioTools } from '../index.js';
import { parseResult, toolText } from '../fork-tools.js';

// Spaces, tabs and CR runs compare as one space and line-end whitespace is ignored. FUZZY_MATCH_LUAU in fork-luau.ts is the Luau port.

const QUOTE_LINES = 12;
const QUOTE_CHARS = 160;
const LISTED_RANGES = 10;
const QUOTED_CANDIDATES = 3;
// Line comparisons allowed when looking for the closest text, so a huge script cannot stall the reply.
const SIMILARITY_BUDGET = 300_000;

export interface FuzzySpan {
  /** UTF-16 offset of the first original character. */
  start: number;
  /** Offset just past the last original character. */
  end: number;
  startLine: number;
  endLine: number;
}

export type FuzzyMatch = { ok: true; spans: FuzzySpan[] } | { ok: false; error: string };

/** The normalized text, and for each of its characters the original [start, end) it stands for. */
export function normalizeWhitespace(text: string): { text: string; starts: number[]; ends: number[] } {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let pending = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (pending < 0) pending = i;
    } else if (ch === '\n') {
      // The newline owns the trailing whitespace it drops, so a replaced span never strands it.
      out += '\n';
      starts.push(pending < 0 ? i : pending);
      ends.push(i + 1);
      pending = -1;
    } else {
      if (pending >= 0) {
        out += ' ';
        starts.push(pending);
        ends.push(i);
        pending = -1;
      }
      out += ch;
      starts.push(i);
      ends.push(i + 1);
    }
  }
  return { text: out, starts, ends };
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

// Non-overlapping matches left to right, and with an anchor only those that start on that line.
function locate(source: string, needle: string, anchor?: number): FuzzySpan[] {
  const wanted = normalizeWhitespace(needle).text;
  if (wanted === '') return [];
  // Normalizing drops a trailing space or tab, which was a word boundary, so the script needs whitespace there too.
  const boundary = /[ \t\r]$/.test(needle);
  const { text, starts, ends } = normalizeWhitespace(source);
  const spans: FuzzySpan[] = [];
  let line = 1;
  let scanned = 0;
  let at = text.indexOf(wanted);
  while (at >= 0) {
    let last = at + wanted.length - 1;
    const after = text[last + 1];
    const start = starts[at];
    line += countNewlines(source, scanned, start);
    scanned = start;
    if (anchor !== undefined && line > anchor) break;
    if ((boundary && after !== undefined && after !== ' ' && after !== '\n') || (anchor !== undefined && line !== anchor)) {
      // A skipped candidate may overlap one that counts, so resume one character on.
      at = text.indexOf(wanted, at + 1);
      continue;
    }
    // The run after the match stands for the trailing whitespace, so new_string's own replaces it.
    if (boundary && after === ' ') last++;
    const end = ends[last];
    spans.push({ start, end, startLine: line, endLine: line + countNewlines(source, start, end - 1) });
    at = text.indexOf(wanted, last + 1);
  }
  return spans;
}

export function lineRange(span: { startLine: number; endLine: number }): string {
  return span.startLine === span.endLine ? String(span.startLine) : `${span.startLine}-${span.endLine}`;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function quote(lines: string[], startLine: number, endLine: number): string {
  const last = Math.min(endLine, startLine + QUOTE_LINES - 1);
  const out: string[] = [];
  for (let n = startLine; n <= last; n++) {
    let line = (lines[n - 1] ?? '').replace(/\r$/, '');
    const chars = Array.from(line);
    if (chars.length > QUOTE_CHARS) line = `${chars.slice(0, QUOTE_CHARS).join('')}...`;
    out.push(`${n}: ${line}`);
  }
  if (endLine > last) out.push(`... ${endLine - last} more lines`);
  return out.join('\n');
}

function lineKey(line: string): string {
  return line.replace(/[ \t\r]+/g, ' ').replace(/^ | $/g, '');
}

function bigrams(key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < key.length - 1; i++) {
    const gram = key.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// Dice coefficient over character bigrams: cheap, and tolerant of the small typos that defeat an exact match.
function similarity(a: string, b: string, ga: Map<string, number>, gb: Map<string, number>): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  let overlap = 0;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

type Window = { startLine: number; endLine: number; percent: number };
type Profile = { keys: string[]; grams: Array<Map<string, number>> };

function profile(lines: string[]): Profile {
  const keys = lines.map(lineKey);
  return { keys, grams: keys.map(bigrams) };
}

function windowAt(lines: Profile, wanted: Profile, startLine: number, compared: number): Window & { score: number } {
  let score = 0;
  for (let i = 1; i <= compared; i++) {
    score += similarity(wanted.keys[i - 1], lines.keys[startLine + i - 2], wanted.grams[i - 1], lines.grams[startLine + i - 2]);
  }
  return {
    startLine,
    endLine: Math.min(lines.keys.length, startLine + wanted.keys.length - 1),
    percent: Math.floor((score / compared) * 100 + 0.5),
    score,
  };
}

/** The window of source lines, as tall as the needle, whose lines look most like it. */
export function closestWindow(source: string, needle: string): Window {
  const lines = profile(splitLines(source));
  const wanted = profile(splitLines(needle));
  const windows = Math.max(1, lines.keys.length - wanted.keys.length + 1);
  const compared = Math.min(wanted.keys.length, lines.keys.length, Math.max(1, Math.floor(SIMILARITY_BUDGET / windows)));
  let best = windowAt(lines, wanted, 1, compared);
  for (let s = 2; s <= windows; s++) {
    const window = windowAt(lines, wanted, s, compared);
    if (window.score > best.score) best = window;
  }
  return { startLine: best.startLine, endLine: best.endLine, percent: best.percent };
}

function quoteWindow(lines: string[], window: Window): string {
  return `${window.startLine === window.endLine ? 'line' : 'lines'} ${lineRange(window)} (${window.percent}% similar):\n`
    + quote(lines, window.startLine, window.endLine);
}

function listRanges(spans: FuzzySpan[]): string {
  return spans.slice(0, LISTED_RANGES).map(lineRange).join(', ') + (spans.length > LISTED_RANGES ? ', ...' : '');
}

// Quotes the anchored lines, then where the text matches or looks closest when that is elsewhere.
function anchoredMiss(source: string, needle: string, lines: string[], line: number): string {
  const wanted = splitLines(needle);
  const startLine = Math.max(1, Math.min(line, lines.length));
  const compared = Math.min(wanted.length, lines.length - startLine + 1);
  const here = windowAt(profile(lines), profile(wanted), startLine, compared);
  const head = `old_string does not match at line ${line}, even ignoring whitespace. Text there is ${quoteWindow(lines, here)}`;
  const elsewhere = locate(source, needle);
  if (elsewhere.length > 0) return `${head}\nIt does match at ${elsewhere.length === 1 ? 'line' : 'lines'} ${listRanges(elsewhere)} ignoring whitespace.`;
  const closest = closestWindow(source, needle);
  return closest.startLine === here.startLine ? head : `${head}\nClosest text is ${quoteWindow(lines, closest)}`;
}

/** One match (every match with all) succeeds, otherwise the error quotes the matches or the closest lines. */
export function fuzzyMatch(source: string, needle: string, options: { all?: boolean; line?: number } = {}): FuzzyMatch {
  if (normalizeWhitespace(needle).text === '') return { ok: false, error: 'old_string not found, and it is only whitespace.' };
  const spans = locate(source, needle, options.line);
  if (spans.length === 1 || (options.all === true && spans.length > 0)) return { ok: true, spans };
  const lines = splitLines(source);
  if (spans.length > 1) {
    const quotes = spans.slice(0, QUOTED_CANDIDATES).map((span) => quote(lines, span.startLine, span.endLine)).join('\n--\n');
    return {
      ok: false,
      error: `old_string is not exact and matches ${spans.length} places ignoring whitespace (lines ${listRanges(spans)}). `
        + `Include more surrounding lines to make it unique:\n${quotes}`,
    };
  }
  if (options.line !== undefined) return { ok: false, error: anchoredMiss(source, needle, lines, options.line) };
  return { ok: false, error: `old_string not found, even ignoring whitespace. Closest text is ${quoteWindow(lines, closestWindow(source, needle))}` };
}

export function applySpans(source: string, spans: FuzzySpan[], replacement: string): string {
  let out = '';
  let from = 0;
  for (const span of spans) {
    out += source.slice(from, span.start) + replacement;
    from = span.end;
  }
  return out + source.slice(from);
}

type ToolResult = { content: Array<{ type: string; text?: string }> };

const MISSED = /old_string not found|old_string does not match at line/;

// The plugin still does the write, given the original text from its line start and anchored there, so it can only land on the match.
export async function retryEditIgnoringWhitespace(
  tools: Pick<RobloxStudioTools, 'editScriptLines' | 'forkHost'>,
  first: ToolResult,
  edit: { path: string; oldString: string; newString: string; line?: number; instanceId?: string },
): Promise<ToolResult> {
  const failure = parseResult(first).error;
  if (typeof failure !== 'string' || !MISSED.test(failure)) return first;
  const peers = await tools.forkHost.peerTargets(undefined, edit.instanceId);
  if (peers.length !== 1) return first;
  const read = async (ranged: boolean) => await tools.forkHost.requestPeer(
    '/api/get-script-source',
    ranged ? { instancePath: edit.path, startLine: 1 } : { instancePath: edit.path },
    peers[0].peerId,
  ) as Record<string, unknown>;
  // An unranged read stops at 300 lines on long scripts, a ranged one returns all of it.
  let reply = await read(false);
  if (reply.truncated === true) reply = await read(true);
  const source = reply.source;
  // A ranged read folds CRLF to LF, and text that differs from the script cannot anchor the write.
  if (typeof source !== 'string' || (typeof reply.sourceLength === 'number' && Buffer.byteLength(source, 'utf8') !== reply.sourceLength)) {
    return first;
  }
  const match = fuzzyMatch(source, edit.oldString, { line: edit.line });
  if (!match.ok) return toolText({ error: `Failed to edit script: ${match.error}` });
  const span = match.spans[0];
  const lineStart = span.start === 0 ? 0 : source.lastIndexOf('\n', span.start - 1) + 1;
  const result = await tools.editScriptLines(
    edit.path,
    source.slice(lineStart, span.end),
    source.slice(lineStart, span.start) + edit.newString,
    span.startLine,
    edit.instanceId,
  );
  const applied = parseResult(result);
  if (applied.success !== true) return result;
  return toolText({ ...applied, fuzzy: true, lines: lineRange(span) });
}

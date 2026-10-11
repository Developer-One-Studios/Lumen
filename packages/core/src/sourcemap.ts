import { execFile } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

// Rojo projects keep scripts on disk; sourcemap.json (rojo sourcemap, also what
// luau-lsp reads) maps every synced instance to its file. With it, Studio paths
// in errors become file:line and edits to synced scripts are sent to the file.
// A missing or stale map is rebuilt in memory from rojo's stdout, because the
// projects may be mounted read only.

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export interface SourcemapIndex {
  sourcemapPath: string;
  projectRoot: string;
  /** When the map was written, or when rojo started building it. */
  mtimeMs: number;
  byPath: Map<string, string>;
  byFile: Map<string, string>;
  /** The project file rojo built this map from, unset for a map read from sourcemap.json. */
  generatedFrom?: string;
  /** That project file's mtime when rojo started, compared for equality so a future mtime cannot keep the map stale. */
  projectMtimeMs?: number;
}

export interface SourcemapRefresh {
  index?: SourcemapIndex;
  /** Why a rebuild was attempted: missing, stale, or requested. */
  stale?: string;
  rebuilt?: boolean;
  /** Why rojo could not rebuild the map, so index is the older one, if any. */
  error?: string;
}

/** Runs `rojo sourcemap` on a project file and resolves with its stdout. */
export type RojoRunner = (project: string, timeoutMs: number) => Promise<string>;

export interface SourcemapResolverOptions {
  runRojo?: RojoRunner;
  /** Rebuild a stale map in the background when a lookup notices it. Defaults to true. */
  autoRefresh?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const LUAU_KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export',
  'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or',
  'repeat', 'return', 'then', 'true', 'type', 'until', 'while',
]);

/** Splits a canonical DataModel path the same way the Studio plugin does. */
export function parseInstancePath(path: string): string[] | undefined {
  if (path === '' || path === 'game') return [];
  let i = path.startsWith('game.') ? 5 : path.startsWith('game[') ? 4 : 0;
  const parts: string[] = [];
  let current = '';
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      if (current !== '') {
        parts.push(current);
        current = '';
      } else if (i > 0 && path[i - 1] === '.' && i < path.length - 1 && path[i + 1] !== '[') {
        // The plugin keeps old `Parent..dir` paths working, where ".dir" is the instance name.
        current = '.';
      }
      i += 1;
    } else if (ch === '[' && (path[i + 1] === '"' || path[i + 1] === "'") && path[i - 1] !== '.') {
      if (current !== '') parts.push(current);
      current = '';
      const quote = path[i + 1];
      let j = i + 2;
      let raw = '';
      while (j < path.length && path[j] !== quote) {
        if (path[j] === '\\' && j + 1 < path.length) {
          const next = path[j + 1];
          raw += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          raw += path[j];
          j += 1;
        }
      }
      if (path[j] !== quote || path[j + 1] !== ']') return undefined;
      parts.push(raw);
      i = j + 2;
    } else {
      current += ch;
      i += 1;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

export function formatInstancePath(parts: readonly string[]): string {
  let path = 'game';
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !LUAU_KEYWORDS.has(part)) {
      path += `.${part}`;
    } else {
      const escaped = part.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/"/g, '\\"');
      path += `["${escaped}"]`;
    }
  }
  return path;
}

export function canonicalPath(path: string): string | undefined {
  const parts = parseInstancePath(path);
  return parts === undefined ? undefined : formatInstancePath(parts);
}

function scriptFile(node: SourcemapNode): string | undefined {
  return node.filePaths?.find((file) => /\.(luau|lua)$/.test(file));
}

export function buildSourcemapIndex(root: SourcemapNode, sourcemapPath: string, mtimeMs = 0): SourcemapIndex {
  const projectRoot = dirname(sourcemapPath);
  const byPath = new Map<string, string>();
  const byFile = new Map<string, string>();
  const visit = (node: SourcemapNode, parts: string[]) => {
    const file = scriptFile(node);
    if (file && parts.length > 0) {
      const absolute = isAbsolute(file) ? file : resolve(projectRoot, file);
      const path = formatInstancePath(parts);
      byPath.set(path, absolute);
      byFile.set(absolute, path);
    }
    for (const child of node.children ?? []) visit(child, [...parts, child.name]);
  };
  // Only a place project's tree starts at the DataModel; a library project has no fixed location in the game.
  if (root.className === 'DataModel') visit(root, []);
  return { sourcemapPath, projectRoot, mtimeMs, byPath, byFile };
}

/** True when path is base itself or one of its descendants. */
export function isUnderPath(path: string, base: string): boolean {
  return base === 'game' || path === base || path.startsWith(`${base}.`) || path.startsWith(`${base}[`);
}

/** A file inside the project as a relative path with forward slashes, the form Rojo's sourcemap uses on every OS. */
export function projectRelative(projectRoot: string, file: string): string {
  const rel = relative(projectRoot, file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel.split(sep).join('/');
}

/** default.project.json, or the only *.project.json when a project names itself differently. */
export function findProjectFile(dir: string): string | undefined {
  const preferred = join(dir, 'default.project.json');
  if (existsSync(preferred)) return preferred;
  try {
    const projects = readdirSync(dir).filter((name) => name.endsWith('.project.json'));
    return projects.length === 1 ? join(dir, projects[0]) : undefined;
  } catch {
    return undefined;
  }
}

export interface ProjectLocation {
  sourcemap?: string;
  project?: string;
}

/** The nearest folder at or above start holding sourcemap.json or default.project.json. */
export function locateProject(start: string, env: NodeJS.ProcessEnv = process.env): ProjectLocation {
  const explicit = env.ROBLOX_SOURCEMAP?.trim();
  if (explicit) {
    const sourcemap = resolve(explicit);
    return { sourcemap: existsSync(sourcemap) ? sourcemap : undefined, project: findProjectFile(dirname(sourcemap)) };
  }
  let dir = resolve(start);
  for (;;) {
    const sourcemap = join(dir, 'sourcemap.json');
    if (existsSync(sourcemap)) return { sourcemap, project: findProjectFile(dir) };
    const project = join(dir, 'default.project.json');
    if (existsSync(project)) return { project };
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

function maxAgeMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ROBLOX_SOURCEMAP_MAX_AGE_S?.trim();
  const seconds = raw ? Number(raw) : NaN;
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 300) * 1000;
}

const ROJO_OUTPUT_LIMIT = 256 * 1024 * 1024;

// Without -o rojo prints the map, so a read only project is never written.
const rojoSourcemap: RojoRunner = (project, timeoutMs) => new Promise((fulfil, reject) => {
  execFile(
    'rojo',
    ['sourcemap', '--color', 'never', project],
    { cwd: dirname(project), encoding: 'utf8', timeout: timeoutMs, maxBuffer: ROJO_OUTPUT_LIMIT, windowsHide: true },
    (error, stdout, stderr) => {
      if (!error) {
        fulfil(stdout);
      } else if (error.code === 'ENOENT') {
        reject(new Error('rojo is not on PATH'));
      } else if (error.killed) {
        reject(new Error(`rojo sourcemap timed out after ${Math.round(timeoutMs / 1000)}s`));
      } else {
        reject(new Error(stderr.replace(/\s+/g, ' ').trim().slice(0, 300) || error.message));
      }
    },
  );
});

// Lookups run on every annotated log line, so a background rebuild never starts more often than this.
const AUTO_REFRESH_INTERVAL_MS = 30_000;

// Runtime copies of starter containers point back at the instance Rojo synced.
// Character scripts are left out: a Workspace path cannot tell a player's character from an NPC.
const RUNTIME_CLONES = new Map<string, string[]>([
  ['PlayerScripts', ['StarterPlayer', 'StarterPlayerScripts']],
  ['PlayerGui', ['StarterGui']],
  ['Backpack', ['StarterPack']],
]);

/** Maps a path in a player's PlayerScripts, PlayerGui or Backpack, the container included, to the starter container it is copied from. */
export function starterPath(parts: readonly string[]): string[] | undefined {
  const starter = parts.length >= 3 && parts[0] === 'Players' ? RUNTIME_CLONES.get(parts[2]) : undefined;
  return starter && [...starter, ...parts.slice(3)];
}

export class SourcemapResolver {
  private fileIndex?: SourcemapIndex;
  private built?: SourcemapIndex;
  private pending?: { run: Promise<SourcemapRefresh>; project: string; id: number };
  private rebuilds = 0;
  private lastRebuild = 0;
  private projectRoot?: string;
  private readonly runRojo: RojoRunner;
  private readonly autoRefresh: boolean;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly startDir: () => string = () => process.cwd(), options: SourcemapResolverOptions = {}) {
    this.runRojo = options.runRojo ?? rojoSourcemap;
    this.autoRefresh = options.autoRefresh ?? true;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.env = options.env ?? process.env;
  }

  setProjectRoot(root: string): void {
    this.projectRoot = resolve(root);
    this.fileIndex = undefined;
    // Starting now narrows the window in which synchronous lookups, like the synced edit refusal, have no map yet.
    if (this.autoRefresh) void this.refresh();
  }

  /** The freshest map at hand. A stale one is still returned while a rebuild runs in the background. */
  current(): SourcemapIndex | undefined {
    const state = this.inspect();
    if (state.stale && this.autoRefresh && !this.pending && Date.now() - this.lastRebuild >= AUTO_REFRESH_INTERVAL_MS) {
      void this.refresh();
    }
    return state.index;
  }

  /** Rebuilds the map with rojo when it is missing, stale, or force is set, and falls back to the older map when rojo fails. */
  async refresh(force = false): Promise<SourcemapRefresh> {
    const startedBefore = this.rebuilds;
    let state = this.inspect();
    while (this.pending) {
      const pending = this.pending;
      // A rebuild of another project, or one that predates a forced call, cannot answer it.
      if (pending.project === state.project && (!force || pending.id > startedBefore)) return pending.run;
      await pending.run;
      if (this.pending === pending) this.pending = undefined;
      state = this.inspect();
    }
    if (!state.project) {
      if (state.index && !force) return { index: state.index };
      return {
        index: state.index,
        error: state.index
          ? 'no *.project.json next to sourcemap.json to rebuild it from'
          : `no sourcemap.json or default.project.json in or above ${this.projectRoot ?? this.startDir()}`,
      };
    }
    const stale = force ? 'regenerate requested' : state.stale;
    if (!stale) return { index: state.index };
    const id = ++this.rebuilds;
    const pending = { run: this.rebuild(state.project, stale, state.index), project: state.project, id };
    this.pending = pending;
    void pending.run.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending.run;
  }

  private async rebuild(project: string, stale: string, fallback: SourcemapIndex | undefined): Promise<SourcemapRefresh> {
    const startedAt = Date.now();
    this.lastRebuild = startedAt;
    try {
      const projectMtimeMs = statSync(project).mtimeMs;
      const root = JSON.parse(await this.runRojo(project, this.timeoutMs)) as SourcemapNode;
      this.built = { ...buildSourcemapIndex(root, project, startedAt), generatedFrom: project, projectMtimeMs };
      return { index: this.built, stale, rebuilt: true };
    } catch (error) {
      return { index: fallback, stale, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private inspect(): { index?: SourcemapIndex; project?: string; stale?: string } {
    const location = locateProject(this.projectRoot ?? this.startDir(), this.env);
    const file = location.sourcemap ? this.readSourcemap(location.sourcemap) : undefined;
    const built = this.built && this.built.generatedFrom === location.project ? this.built : undefined;
    const index = built && (!file || built.mtimeMs > file.mtimeMs) ? built : file;
    if (!index) return { project: location.project, stale: location.project ? 'no sourcemap.json' : undefined };
    if (!location.project) return { index };
    return { index, project: location.project, stale: this.staleness(index, location.project) };
  }

  private staleness(index: SourcemapIndex, project: string): string | undefined {
    let projectMtimeMs: number;
    try {
      projectMtimeMs = statSync(project).mtimeMs;
    } catch {
      return undefined;
    }
    const changed = index.projectMtimeMs === undefined ? projectMtimeMs > index.mtimeMs : projectMtimeMs !== index.projectMtimeMs;
    if (changed) return `${basename(project)} changed after the map was built`;
    const maxAge = maxAgeMs(this.env);
    if (Date.now() - index.mtimeMs > maxAge) return `the map is over ${Math.round(maxAge / 1000)}s old`;
    return undefined;
  }

  private readSourcemap(path: string): SourcemapIndex | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
    if (this.fileIndex?.sourcemapPath === path && this.fileIndex.mtimeMs === mtimeMs) return this.fileIndex;
    try {
      const root = JSON.parse(readFileSync(path, 'utf8')) as SourcemapNode;
      this.fileIndex = buildSourcemapIndex(root, path, mtimeMs);
    } catch {
      this.fileIndex = undefined;
    }
    return this.fileIndex;
  }

  /** Runtime clones only make sense for playtest locations; edits target the edit DataModel, so they pass false. */
  fileForPath(studioPath: string, runtimeClones = true): string | undefined {
    const index = this.current();
    const parts = parseInstancePath(studioPath);
    if (!index || !parts) return undefined;
    const direct = index.byPath.get(formatInstancePath(parts));
    if (direct || !runtimeClones) return direct;
    const starter = starterPath(parts);
    return starter && index.byPath.get(formatInstancePath(starter));
  }

  pathForFile(file: string): string | undefined {
    const index = this.current();
    if (!index) return undefined;
    return index.byFile.get(isAbsolute(file) ? file : resolve(index.projectRoot, file));
  }

  /** Synced scripts at or below a Studio path, so bulk edits can refuse instead of being overwritten. */
  syncedUnder(studioPath: string | undefined): string[] {
    const index = this.current();
    if (!index) return [];
    const base = studioPath === undefined ? 'game' : canonicalPath(studioPath);
    if (base === undefined) return [];
    return [...index.byPath.keys()].filter((path) => isUnderPath(path, base));
  }

  displayFile(file: string): string {
    const index = this.current();
    return index ? projectRelative(index.projectRoot, file) : file;
  }

  annotateText(text: string): string {
    if (!this.current()) return text;
    return text.replace(STUDIO_LOCATION, (match, path: string, colonLine?: string, legacyLine?: string) => {
      const file = this.fileForPath(path);
      if (!file) return match;
      return `${match} [${this.displayFile(file)}:${colonLine ?? legacyLine}]`;
    });
  }

  annotateValue<T>(value: T): T {
    if (!this.current()) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') return this.annotateText(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
      }
      return node;
    };
    return walk(value) as T;
  }
}

// `ServerScriptService.Combat.Damage:42` from errors and tracebacks, or the older `Script 'Path', Line 42`.
const STUDIO_LOCATION = /\b((?:game\.)?[A-Z][A-Za-z]+(?:\.[A-Za-z0-9_-]+)+)(?::(\d+)|', Line (\d+))(?!\d| \[)/g;

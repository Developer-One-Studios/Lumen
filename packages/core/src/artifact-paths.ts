import * as fs from 'fs';
import * as path from 'path';

// Tool arguments choose these paths, so without a root a prompt-injected agent can overwrite any file the server can.
// ROBLOX_MCP_ARTIFACT_DIR confines every tool-written file to one directory; relative paths resolve inside it.

/** Writes a tool artifact and returns the absolute path written. */
export function writeArtifact(requested: string, data: string | Buffer, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ROBLOX_MCP_ARTIFACT_DIR?.trim();
  if (!root) {
    const target = path.resolve(requested);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  }

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, requested);
  if (!isInside(resolvedRoot, target) || target === resolvedRoot) {
    throw new Error(`Output path ${requested} is outside ROBLOX_MCP_ARTIFACT_DIR (${resolvedRoot}).`);
  }

  // Each directory is created or checked one level at a time, so a symlinked directory can never lead the write elsewhere.
  fs.mkdirSync(resolvedRoot, { recursive: true });
  let current = resolvedRoot;
  for (const part of path.relative(resolvedRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      fs.mkdirSync(current);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Output path ${requested} passes through ${current}, which is not a plain directory.`);
    }
  }

  // Windows has no O_NOFOLLOW, so a planted symlink at the final name, dangling or not, is refused before opening,
  // a new file is created exclusively, and an existing one must still be the checked file before it is truncated.
  const symlink = () => new Error(`Output path ${requested} is a symlink; refusing to write through it.`);
  const before = fs.lstatSync(target, { throwIfNoEntry: false, bigint: true });
  if (before?.isSymbolicLink()) throw symlink();
  if (before && !before.isFile()) throw new Error(`Output path ${requested} is not a plain file.`);
  const create = before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | create | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw symlink();
    if (code === 'EEXIST') throw new Error(`Output path ${requested} appeared while it was being opened; refusing to write.`);
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (before && (opened.ino !== before.ino || opened.dev !== before.dev)) throw symlink();
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

/** Advice for an input file the server cannot see. A sandboxed server sees only the folders it was given. */
export function missingInputHint(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ROBLOX_MCP_ARTIFACT_DIR?.trim();
  return root
    ? `Lumen may only see some folders, so copy the file into the artifact folder ${path.resolve(root)} and pass that path.`
    : 'Check that the Lumen server process can see this path. A sandboxed server only sees the folders it was given.';
}

// Baselines are files these tools wrote, so reads stay inside the same root.
export function resolveArtifactReadPath(requested: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ROBLOX_MCP_ARTIFACT_DIR?.trim();
  if (!root) return path.resolve(requested);
  const realRoot = fs.realpathSync(path.resolve(root));
  const target = fs.realpathSync(path.resolve(realRoot, requested));
  if (!isInside(realRoot, target)) {
    throw new Error(`Input path ${requested} is outside ROBLOX_MCP_ARTIFACT_DIR (${realRoot}).`);
  }
  return target;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

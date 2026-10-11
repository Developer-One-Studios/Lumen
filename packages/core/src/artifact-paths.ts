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

  // O_NOFOLLOW refuses a planted symlink at the final name, dangling or not.
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Output path ${requested} is a symlink; refusing to write through it.`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return target;
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

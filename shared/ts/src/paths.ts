import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { compareText } from './gen/files.ts';

const EXECUTE_BITS = 0o111;

/** Mode of an installed or scaffolded executable and of every directory tbx creates. */
export const EXECUTABLE_MODE = 0o755;
/** Mode of a regular file tbx writes. */
export const READABLE_MODE = 0o644;
/** Mode of the tbx state directory, which holds the install record and its lock. */
export const PRIVATE_DIR_MODE = 0o700;

/** Environment variables a path helper reads. */
export type PathEnv = Readonly<Record<string, string | undefined>>;

/** An executable found on PATH: its file name and the PATH entry path it was found at. */
export interface PathBinary {
  name: string;
  path: string;
}

function absoluteOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

/**
 * `env[variable]` when it is an absolute path, otherwise `<home>/<fallback>` with home from
 * `env.HOME` (then the OS home). Empty and relative values are ignored, as the XDG Base
 * Directory spec requires.
 *
 * @example xdgBaseDir(env, 'XDG_DATA_HOME', '.local/share')
 */
export function xdgBaseDir(env: PathEnv, variable: string, fallback: string): string {
  const home = env.HOME === undefined || env.HOME === '' ? homedir() : env.HOME;
  return absoluteOrUndefined(env[variable]) ?? path.join(home, fallback);
}

/**
 * The directory `tbx install` links tool binaries into: `$TBX_BIN_DIR` when it is an absolute
 * path, otherwise `$XDG_DATA_HOME/tbx/bin` (see `xdgBaseDir`), otherwise `~/.local/share/tbx/bin`.
 *
 * @param env the environment to read; defaults to `process.env`.
 */
export function tbxBinDir(env: PathEnv = process.env): string {
  return (
    absoluteOrUndefined(env.TBX_BIN_DIR) ??
    path.join(xdgBaseDir(env, 'XDG_DATA_HOME', '.local/share'), 'tbx/bin')
  );
}

/**
 * True when `file` is `root` or lies below it. Both are resolved first; a sibling whose name
 * starts with `..` (for example `..foo`) counts as inside.
 */
export function isWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolved(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}

function isInside(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(root, file));
}

async function hasAnyExecuteBit(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && (info.mode & EXECUTE_BITS) !== 0;
  } catch {
    return false;
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function resolvedRoots(roots: readonly string[]): Promise<string[]> {
  const all = await Promise.all(roots.map(async (root) => [root, (await resolved(root)) ?? root]));
  return all.flat();
}

async function binariesIn(dir: string, excluded: readonly string[]): Promise<PathBinary[]> {
  const found: PathBinary[] = [];
  for (const name of await entriesOf(dir)) {
    const file = path.join(dir, name);
    const target = await resolved(file);
    if (target === null || isInside(target, excluded)) continue;
    if (await hasAnyExecuteBit(file)) found.push({ name, path: file });
  }
  return found;
}

/**
 * Returns the path of the first executable regular file called `name` (symlinks followed) in
 * the directories of a PATH-style string, or `null` when no entry has one. The path is the
 * PATH entry joined with `name`, not its real path.
 */
export async function findOnPath(name: string, pathVariable: string): Promise<string | null> {
  for (const dir of pathVariable.split(path.delimiter).filter((entry) => entry !== '')) {
    const file = path.join(dir, name);
    if (await hasAnyExecuteBit(file)) return file;
  }
  return null;
}

/**
 * Lists the executable regular files (symlinks followed) in each directory of a PATH-style
 * string, one per name with the first PATH entry winning, sorted by name. Empty entries,
 * unreadable directories, non-executables, directories and broken symlinks are skipped, as
 * are PATH entries and executables whose real path lies inside one of `excludedRoots` (for
 * example the repo checkout and the tbx-managed bin directory, so a tool never collides with
 * its own shim).
 *
 * @param pathVariable the PATH value; defaults to `process.env.PATH`.
 * @param excludedRoots directories whose contents never count as PATH binaries.
 */
export async function binariesOnPath(
  pathVariable: string = process.env.PATH ?? '',
  excludedRoots: readonly string[] = [],
): Promise<PathBinary[]> {
  const excluded = await resolvedRoots(excludedRoots);
  const byName = new Map<string, PathBinary>();
  for (const dir of pathVariable.split(path.delimiter).filter((entry) => entry !== '')) {
    const real = await resolved(dir);
    if (real === null || isInside(real, excluded)) continue;
    for (const binary of await binariesIn(dir, excluded)) {
      if (!byName.has(binary.name)) byName.set(binary.name, binary);
    }
  }
  return [...byName.values()].sort((a, b) => compareText(a.name, b.name));
}

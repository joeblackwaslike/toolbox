import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { compareText } from './gen/files.ts';

const EXECUTE_BITS = 0o111;

/** An executable found on PATH: its file name and the PATH entry path it was found at. */
export interface PathBinary {
  name: string;
  path: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * The directory `tbx install` links tool binaries into: `$TBX_BIN_DIR` when set, otherwise
 * `$XDG_DATA_HOME/tbx/bin`, otherwise `~/.local/share/tbx/bin`.
 *
 * @param env the environment to read; defaults to `process.env`.
 */
export function tbxBinDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = nonEmpty(env.TBX_BIN_DIR);
  if (override !== undefined) return override;
  const dataHome = nonEmpty(env.XDG_DATA_HOME) ?? path.join(env.HOME ?? homedir(), '.local/share');
  return path.join(dataHome, 'tbx/bin');
}

async function resolved(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}

function isInside(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

async function isExecutableFile(file: string): Promise<boolean> {
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
    if (await isExecutableFile(file)) found.push({ name, path: file });
  }
  return found;
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

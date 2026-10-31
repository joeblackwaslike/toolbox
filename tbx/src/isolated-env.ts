import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { findOnPath } from '../../shared/ts/src/paths.ts';

/**
 * Commands linked into an isolated environment's PATH when the host PATH has them. A tool
 * that needs anything else stubs it in its own tests.
 */
export const ALLOWED_COMMANDS = [
  'sh',
  'bash',
  'env',
  'cat',
  'printf',
  'true',
  'false',
  'sleep',
  'mkdir',
  'rm',
  'ls',
  'chmod',
  'readlink',
  'dirname',
  'basename',
  'uname',
  'tr',
  'sed',
  'grep',
  'jq',
  'python3',
  'bun',
  'node',
  'script',
] as const;

/** A throwaway HOME with its own XDG directories, tbx bin directory and minimal PATH. */
export interface IsolatedEnv {
  /** The temp HOME. */
  home: string;
  /** The complete environment to run tools with; nothing is inherited from the host. */
  env: NodeJS.ProcessEnv;
  /** Removes the whole temp tree; safe to call more than once. */
  cleanup(): Promise<void>;
}

function within(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function scratchBase(): string {
  const base = tmpdir();
  const homes = [homedir(), userInfo().homedir].filter((home) => home.length > 1);
  return homes.some((home) => within(base, home)) ? '/tmp' : base;
}

async function linkCommands(stubs: string, hostPath: string): Promise<void> {
  for (const name of ALLOWED_COMMANDS) {
    const target = await findOnPath(name, hostPath);
    if (target !== null) await symlink(target, path.join(stubs, name));
  }
}

/**
 * Creates an isolated environment under the OS temp directory (or `/tmp` when that lies
 * inside the real home): a temp HOME with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 * `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TBX_BIN_DIR` and `TMPDIR` under it, and a `PATH` of a
 * single stub directory holding symlinks to the `ALLOWED_COMMANDS` found on the host PATH.
 * No other variable is set, so the real HOME never reaches a tool. Wrap every use in
 * `try`/`finally` with `cleanup()`.
 */
export async function createIsolatedEnv(): Promise<IsolatedEnv> {
  const root = await realpath(await mkdtemp(path.join(scratchBase(), 'tbx-verify-')));
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  const directories: [string, string][] = [
    ['XDG_CONFIG_HOME', path.join(home, '.config')],
    ['XDG_DATA_HOME', path.join(home, '.local/share')],
    ['XDG_STATE_HOME', path.join(home, '.local/state')],
    ['XDG_CACHE_HOME', path.join(home, '.cache')],
    ['TMPDIR', path.join(home, 'tmp')],
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries([
    ['HOME', home],
    ...directories,
    ['TBX_BIN_DIR', path.join(home, '.local/share/tbx/bin')],
    ['PATH', stubs],
  ]);
  try {
    for (const [, dir] of directories) await mkdir(dir, { recursive: true });
    await mkdir(stubs);
    await linkCommands(stubs, process.env.PATH ?? '');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

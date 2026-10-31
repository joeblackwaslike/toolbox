import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { NAME_PATTERN } from '../../shared/ts/src/manifest.ts';
import { tbxBinDir } from '../../shared/ts/src/paths.ts';

/** Environment variables the install layout reads (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `TBX_BIN_DIR`). */
export type Env = Readonly<Record<string, string | undefined>>;

/** Where `tbx install` keeps tools, links, state and its lock for one home directory. */
export interface TbxPaths {
  /** `<data>/tbx/tools`: one immutable `<name>/<version>/` directory per installed version. */
  tools: string;
  /** `<data>/tbx/staging`: scratch space on the same filesystem as `tools`. */
  staging: string;
  /** The managed bin directory from `tbxBinDir`. */
  bin: string;
  /** `<state>/tbx/installed.json`. */
  stateFile: string;
  /** `<state>/tbx/install.lock`, held while installing or uninstalling. */
  lockFile: string;
}

const LOCK_POLL_START_MS = 25;
const LOCK_POLL_MAX_MS = 500;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const SUFFIX_BYTES = 4;
const TOKEN_BYTES = 8;

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

/** A copy of `env` with `name` set to `value`. */
export function withVariable(env: Env, name: string, value: string): Env {
  return { ...env, [name]: value };
}

/**
 * Resolves the install layout for `home`: data under `$XDG_DATA_HOME` (default
 * `<home>/.local/share`), state under `$XDG_STATE_HOME` (default `<home>/.local/state`) and links
 * in `tbxBinDir`, all read from `env` and never from `process.env`.
 */
export function tbxPaths(home: string, env: Env): TbxPaths {
  const data = path.join(nonEmpty(env.XDG_DATA_HOME) ?? path.join(home, '.local/share'), 'tbx');
  const state = path.join(nonEmpty(env.XDG_STATE_HOME) ?? path.join(home, '.local/state'), 'tbx');
  return {
    tools: path.join(data, 'tools'),
    staging: path.join(data, 'staging'),
    bin: tbxBinDir(withVariable(env, 'HOME', home)),
    stateFile: path.join(state, 'installed.json'),
    lockFile: path.join(state, 'install.lock'),
  };
}

/**
 * Throws unless `name` matches the manifest `NAME_PATTERN`. Call it before building any path
 * from a tool name.
 *
 * @throws {ToolError} with exit code 2.
 */
export function assertToolName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      `invalid tool name "${name}": use a lowercase letter, then up to 15 lowercase letters, digits or dashes`,
      ExitCode.usage,
    );
  }
}

const stateSchema = z.strictObject({
  tools: z.record(
    z.string().regex(NAME_PATTERN),
    z.strictObject({ version: z.string(), installedAt: z.string() }),
  ),
});

/** The install record at `installed.json`. */
export type InstallState = z.infer<typeof stateSchema>;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Reads the install record, or an empty one when the file does not exist yet.
 *
 * @throws {ToolError} with exit code 78 when the file is not a valid record.
 */
export async function readState(paths: TbxPaths): Promise<InstallState> {
  let text: string;
  try {
    text = await readFile(paths.stateFile, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { tools: {} };
    throw error;
  }
  try {
    return stateSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new ToolError(
      `${paths.stateFile} is not a valid install record: ${error instanceof Error ? error.message : String(error)}`,
      ExitCode.config,
    );
  }
}

function temporaryName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(SUFFIX_BYTES).toString('hex')}.tmp`;
}

/**
 * Replaces `file` with `content` atomically: the bytes are written and flushed to a temp file in
 * the same directory, which is then renamed over `file`, so readers see the old or the new
 * content and never a partial write.
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryName(file);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes the install record with `writeFileAtomic`. */
export async function writeState(paths: TbxPaths, state: InstallState): Promise<void> {
  await writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

interface LockOwner {
  pid: number;
  createdAt: string;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(file: string): Promise<{ raw: string; owner: LockOwner | null } | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const owner = JSON.parse(raw) as LockOwner;
    return { raw, owner: Number.isInteger(owner.pid) ? owner : null };
  } catch {
    return { raw, owner: null };
  }
}

async function tryAcquire(file: string, body: string): Promise<boolean> {
  const temporary = temporaryName(file);
  await writeFileAtomic(temporary, body);
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeIfStale(file: string): Promise<LockOwner | null> {
  const seen = await readOwner(file);
  if (seen === null) return null;
  if (seen.owner !== null && isRunning(seen.owner.pid)) return seen.owner;
  // ponytail: a second waiter can re-read between our read and rm; per-lock fencing tokens if that ever bites.
  const again = await readOwner(file);
  if (again?.raw === seen.raw) await rm(file, { force: true });
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(file: string, timeoutMs: number): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(TOKEN_BYTES).toString('hex'),
  });
  const deadline = Date.now() + timeoutMs;
  let wait = LOCK_POLL_START_MS;
  for (;;) {
    if (await tryAcquire(file, body)) return body;
    const owner = await removeIfStale(file);
    if (owner === null) continue;
    if (Date.now() >= deadline) {
      throw new ToolError(
        `another tbx install is running (pid ${owner.pid}, since ${owner.createdAt}); waited ${timeoutMs} ms for ${file}. Remove it if no tbx process is running.`,
        ExitCode.unavailable,
      );
    }
    await sleep(Math.min(wait, Math.max(deadline - Date.now(), 1)));
    wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
  }
}

/**
 * Runs `body` while holding the lock file at `file`, so installs, updates and uninstalls never
 * overlap. The lock is created atomically (a fully written temp file hard-linked into place)
 * and holds the owner's pid and start time. A second caller polls with backoff for up to
 * `timeoutMs`; a lock whose owner pid is no longer running is taken over. The lock is removed
 * afterwards only if it is still ours.
 *
 * @throws {ToolError} with exit code 69 when the lock is still held after `timeoutMs`.
 */
export async function withLock<T>(
  file: string,
  body: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  const mine = await acquire(file, timeoutMs);
  try {
    return await body();
  } finally {
    const current = await readOwner(file);
    if (current?.raw === mine) await rm(file, { force: true });
  }
}

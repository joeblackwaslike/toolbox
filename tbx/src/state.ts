import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ExitCode, ToolError, isErrnoException, messageOf } from '../../shared/ts/src/errors.ts';
import { NAME_PATTERN } from '../../shared/ts/src/manifest.ts';
import {
  EXECUTABLE_MODE,
  PRIVATE_DIR_MODE,
  READABLE_MODE,
  tbxBinDir,
  xdgBaseDir,
} from '../../shared/ts/src/paths.ts';

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

/** A copy of `env` with `name` set to `value`. */
export function withVariable(env: Env, name: string, value: string): Env {
  return { ...env, [name]: value };
}

/**
 * Resolves the install layout for `home`: data under `$XDG_DATA_HOME` (default
 * `<home>/.local/share`), state under `$XDG_STATE_HOME` (default `<home>/.local/state`) and links
 * in `tbxBinDir`, all read from `env` and never from `process.env`. Relative XDG values are
 * ignored (see `xdgBaseDir`).
 */
export function tbxPaths(home: string, env: Env): TbxPaths {
  const homeEnv = withVariable(env, 'HOME', home);
  const data = path.join(xdgBaseDir(homeEnv, 'XDG_DATA_HOME', '.local/share'), 'tbx');
  const state = path.join(xdgBaseDir(homeEnv, 'XDG_STATE_HOME', '.local/state'), 'tbx');
  return {
    tools: path.join(data, 'tools'),
    staging: path.join(data, 'staging'),
    bin: tbxBinDir(homeEnv),
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

/**
 * The record for `name`, read as an own property so names such as `constructor` never resolve
 * to `Object.prototype` members.
 */
export function recordOf(
  state: InstallState,
  name: string,
): InstallState['tools'][string] | undefined {
  return Object.hasOwn(state.tools, name) ? state.tools[name] : undefined;
}

function isMissing(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
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
      `${paths.stateFile} is not a valid install record: ${messageOf(error)}`,
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
 * content and never a partial write. Missing parent directories are created with `dirMode`
 * (default 0755) and the file gets mode 0644.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Uint8Array,
  options: { dirMode?: number } = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: options.dirMode ?? EXECUTABLE_MODE });
  const temporary = temporaryName(file);
  const handle = await open(temporary, 'wx', READABLE_MODE);
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
  await writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, {
    dirMode: PRIVATE_DIR_MODE,
  });
}

/** Test-only interleaving points inside `withLock`; the CLI never sets them. */
export interface LockHooks {
  /** Awaited after a lock was judged stale and before it is claimed. */
  beforeStaleClaim?: () => Promise<void>;
  /** Awaited after the lock file was created and before the body runs. */
  afterAcquire?: () => Promise<void>;
}

const lockOwnerSchema = z.object({ pid: z.number().int(), createdAt: z.string() });

/**
 * Lock bodies this process holds or is creating, added before the lock file exists so a
 * same-process waiter never sees our own lock without its entry. The set is per isolate: worker
 * threads that share a pid are not supported (tbx uses none).
 */
const HELD_LOCKS = new Set<string>();

async function tryAcquireHeld(file: string, body: string): Promise<boolean> {
  HELD_LOCKS.add(body);
  try {
    if (await tryAcquire(file, body)) return true;
  } catch (error) {
    HELD_LOCKS.delete(body);
    throw error;
  }
  HELD_LOCKS.delete(body);
  return false;
}

type LockOwner = z.infer<typeof lockOwnerSchema>;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function isLive(owner: LockOwner, raw: string): boolean {
  if (owner.pid === process.pid) return HELD_LOCKS.has(raw);
  return isRunning(owner.pid);
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = lockOwnerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readOwner(file: string): Promise<{ raw: string; owner: LockOwner | null } | null> {
  const raw = await readIfExists(file);
  return raw === null ? null : { raw, owner: parseOwner(raw) };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function tryAcquire(file: string, body: string): Promise<boolean> {
  const temporary = temporaryName(file);
  await writeFileAtomic(temporary, body, { dirMode: PRIVATE_DIR_MODE });
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

const TAKEOVER_STALE_MS = 5000;

function mutexFileFor(file: string): string {
  return `${file}.takeover`;
}

/**
 * Deletes `file` only while holding the short-lived takeover mutex at `file.takeover`, and only if
 * `file` still holds exactly `seen` (the dead-owner content this process observed). Serializing
 * every stale claim through one mutex means a delayed waiter can never act on a `seen` value a
 * live installer has since replaced: the lock file itself is never renamed aside or restored, so
 * it never goes missing out from under a live owner, and no third process can slip into that gap.
 */
async function claimStale(file: string, seen: string): Promise<void> {
  const mutex = mutexFileFor(file);
  const mutexBody = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(TOKEN_BYTES).toString('hex'),
  });
  if (!(await tryAcquireHeld(mutex, mutexBody))) {
    await clearDeadMutex(mutex);
    return;
  }
  try {
    if ((await readIfExists(file)) === seen) await rm(file, { force: true });
  } finally {
    HELD_LOCKS.delete(mutexBody);
    await release(mutex, mutexBody);
  }
}

/**
 * Removes the takeover mutex if its own owner is dead and the mutex is older than
 * `TAKEOVER_STALE_MS`, so a crash while holding it cannot wedge every future install.
 */
async function clearDeadMutex(mutex: string): Promise<void> {
  const seen = await readOwner(mutex);
  if (seen?.owner == null || isLive(seen.owner, seen.raw)) return;
  if (Date.now() - new Date(seen.owner.createdAt).getTime() < TAKEOVER_STALE_MS) return;
  try {
    if ((await readIfExists(mutex)) === seen.raw) await rm(mutex, { force: true });
  } catch {
    // another waiter is already clearing or holding it; leave it alone
  }
}

async function removeIfStale(file: string, hooks: LockHooks): Promise<LockOwner | null> {
  const seen = await readOwner(file);
  if (seen === null) return null;
  if (seen.owner !== null && isLive(seen.owner, seen.raw)) return seen.owner;
  await hooks.beforeStaleClaim?.();
  await claimStale(file, seen.raw);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(file: string, timeoutMs: number, hooks: LockHooks): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const body = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(TOKEN_BYTES).toString('hex'),
  });
  const deadline = Date.now() + timeoutMs;
  let wait = LOCK_POLL_START_MS;
  for (;;) {
    if (await tryAcquireHeld(file, body)) return body;
    const owner = await removeIfStale(file, hooks);
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

async function release(file: string, mine: string): Promise<void> {
  try {
    if ((await readIfExists(file)) === mine) await rm(file, { force: true });
  } catch {
    return;
  }
}

/**
 * Runs `body` while holding the lock file at `file`, so installs, updates and uninstalls never
 * overlap. The lock is created atomically (a fully written temp file hard-linked into place)
 * and holds the owner's pid and start time. A second caller polls with backoff for up to
 * `timeoutMs`. A lock whose owner pid is no longer running is claimed only while holding a
 * short-lived takeover mutex (the same atomic hard-link primitive, at `file.takeover`): the
 * holder rereads the lock and deletes it only if it still has the exact dead-owner content it
 * saw before claiming the mutex, so a delayed waiter can never delete a lock a live installer
 * has since replaced. The lock itself is never renamed aside or restored. A lock carrying this
 * process's own pid counts as stale unless a body in this process holds it. The lock is removed
 * afterwards only if it is still ours; a failure while removing it never replaces the result or
 * error of `body` (a lock left behind holds a pid that is no longer running, so the next caller
 * takes it over).
 *
 * @param hooks test-only interleaving points; leave unset.
 * @throws {ToolError} with exit code 69 when the lock is still held after `timeoutMs`.
 */
export async function withLock<T>(
  file: string,
  body: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  hooks: LockHooks = {},
): Promise<T> {
  const mine = await acquire(file, timeoutMs, hooks);
  try {
    await hooks.afterAcquire?.();
    return await body();
  } finally {
    HELD_LOCKS.delete(mine);
    await release(file, mine);
  }
}

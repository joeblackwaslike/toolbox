import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ToolError, isErrnoException, messageOf } from '../../../shared/ts/src/errors.ts';
import { ManifestError, type ToolManifest, loadManifest } from '../../../shared/ts/src/manifest.ts';
import { EXECUTABLE_MODE } from '../../../shared/ts/src/paths.ts';
import type { TbxContext } from '../context.ts';
import { assertLinksOwned, identifiers, linksCurrent, toolLinks } from '../links.ts';
import { fetchArtifact, fetchIndex } from '../remote.ts';
import { ARTIFACT_MARKER, UnsupportedPlatformError, stageArtifact } from '../stage.ts';
import {
  type Env,
  type TbxPaths,
  assertToolName,
  readState,
  recordOf,
  tbxPaths,
  withLock,
  writeState,
} from '../state.ts';
import { pathExists } from '../templates.ts';
import type { IndexEntry } from './build.ts';

/** Points between install steps where a test can kill the process with `faultAt`. */
export const FAULT_POINTS = [
  'after-extract',
  'after-move',
  'after-link',
  'after-state',
  'after-aside',
] as const;
/** One of `FAULT_POINTS`. */
export type FaultPoint = (typeof FAULT_POINTS)[number];

/** Options for `installTool`. */
export interface InstallOptions {
  /** Tool to install; checked against the manifest name pattern before any path is built. */
  name: string;
  /** Local path, `file:` URL or `https:` URL of the release `index.json`. */
  index: string;
  /** Home directory the install layout is resolved against. */
  home: string;
  /** Environment for `XDG_DATA_HOME`, `XDG_STATE_HOME`, `TBX_BIN_DIR` and `CI`; defaults to `process.env`. */
  env?: Env;
  /**
   * Library-only test hook, never set by the CLI: SIGKILL this process at that step, to prove an
   * interrupted install is safe. `after-aside` fires when an old version has been moved aside.
   */
  faultAt?: FaultPoint;
  /** How long to wait for another install's lock; defaults to 60 seconds. */
  lockTimeoutMs?: number;
  /** Receives warnings such as a skipped unit validator; defaults to stderr. */
  warn?: (message: string) => void;
}

function fault(options: { faultAt?: FaultPoint }, point: FaultPoint): void {
  if (options.faultAt === point) process.kill(process.pid, 'SIGKILL');
}

function envOf(options: { env?: Env }): Env {
  return options.env ?? process.env;
}

async function findEntry(index: string, name: string): Promise<IndexEntry> {
  const entries = await fetchIndex(index);
  const entry = entries.find((tool) => tool.name === name);
  if (entry === undefined) throw new ToolError(`${name} is not in ${index}`);
  return entry;
}

async function readText(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8');
    return text.trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    throw new ToolError(`cannot move ${from} to ${to}: the target already exists (${code})`);
  }
}

async function removeAside(
  dir: string,
  staging: string,
  options: { faultAt?: FaultPoint } = {},
): Promise<void> {
  if (!(await pathExists(dir))) return;
  await mkdir(staging, { recursive: true, mode: EXECUTABLE_MODE });
  const aside = await mkdtemp(path.join(staging, 'removed-'));
  await moveDir(dir, path.join(aside, path.basename(dir)));
  fault(options, 'after-aside');
  await rm(aside, { recursive: true, force: true });
}

async function hasInstalledMode(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && (info.mode & EXECUTABLE_MODE) === EXECUTABLE_MODE;
  } catch {
    return false;
  }
}

async function placeVersion(
  stage: string,
  versionDir: string,
  entry: IndexEntry,
  staging: string,
): Promise<void> {
  const installed = await readText(path.join(versionDir, ARTIFACT_MARKER));
  if (installed !== null && (await hasInstalledMode(path.join(versionDir, 'bin', entry.name)))) {
    if (installed === entry.sha256) return;
    throw new ToolError(
      `${entry.name} ${entry.version} is already installed from a different artifact; installed versions are immutable, so bump the version or uninstall first`,
    );
  }
  await removeAside(versionDir, staging);
  await mkdir(path.dirname(versionDir), { recursive: true, mode: EXECUTABLE_MODE });
  await moveDir(stage, versionDir);
}

async function swapLink(link: string, target: string): Promise<void> {
  const dir = path.dirname(link);
  await mkdir(dir, { recursive: true, mode: EXECUTABLE_MODE });
  const prefix = `.${path.basename(link)}.`;
  const entries = await readdir(dir);
  for (const stale of entries.filter((file) => file.startsWith(prefix) && file.endsWith('.tmp'))) {
    await rm(path.join(dir, stale), { force: true });
  }
  const temporary = path.join(dir, `${prefix}${process.pid}.tmp`);
  await symlink(target, temporary);
  await rename(temporary, link);
}

async function prune(
  toolDir: string,
  keep: ReadonlySet<string>,
  staging: string,
  options: InstallOptions,
): Promise<void> {
  for (const version of await readdir(toolDir)) {
    if (keep.has(version)) continue;
    await removeAside(path.join(toolDir, version), staging, options);
  }
}

async function activate(
  m: ToolManifest,
  versionDir: string,
  paths: TbxPaths,
  options: InstallOptions,
): Promise<void> {
  const state = await readState(paths);
  const previous = recordOf(state, m.name);
  const binary = path.join(versionDir, 'bin', m.name);
  if (previous?.version === m.version && (await linksCurrent(m, paths, binary))) return;
  const wanted = new Set(identifiers(m).map((identifier) => path.join(paths.bin, identifier)));
  for (const link of wanted) await swapLink(link, binary);
  for (const link of await toolLinks(paths, m.name)) {
    if (!wanted.has(link)) await rm(link, { force: true });
  }
  fault(options, 'after-link');
  const record = { version: m.version, installedAt: new Date().toISOString() };
  await writeState(paths, { tools: { ...state.tools, [m.name]: record } });
  fault(options, 'after-state');
  if (previous !== undefined && previous.version !== m.version) {
    const keep = new Set([m.version, previous.version]);
    await prune(path.dirname(versionDir), keep, paths.staging, options);
  }
}

async function installLocked(
  entry: IndexEntry,
  paths: TbxPaths,
  options: InstallOptions,
): Promise<void> {
  const bytes = await fetchArtifact(entry, options.index);
  await rm(paths.staging, { recursive: true, force: true });
  await mkdir(paths.staging, { recursive: true, mode: EXECUTABLE_MODE });
  const stage = await mkdtemp(path.join(paths.staging, `${entry.name}-`));
  try {
    const m = await stageArtifact(bytes, entry, stage, path.join(paths.bin, entry.name), options);
    await assertLinksOwned(m, paths);
    fault(options, 'after-extract');
    const versionDir = path.join(paths.tools, m.name, m.version);
    await placeVersion(stage, versionDir, entry, paths.staging);
    fault(options, 'after-move');
    await activate(m, versionDir, paths, options);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Installs `name` from the release index under `home`, holding the install lock throughout:
 * verify the artifact checksum, extract it (only `bin/<name>` and `tool.toml`, as regular files)
 * into a staging directory on the same filesystem, render any unit into its `units/` without
 * touching the system, move it to `tools/<name>/<version>/`, swap the bin link atomically, then
 * write `installed.json` atomically. The previous version stays in place and linked until the
 * new link is active; afterwards only the current and previous versions are kept, each removal
 * renaming the directory aside into staging first. An existing version directory is reused only
 * when its marker matches and its binary is an executable file; a partial one is replaced.
 * Reinstalling the installed version is a no-op. A failure or kill at any step leaves the previous version
 * runnable and the state file valid, and a rerun completes the install.
 *
 * @throws {ToolError} for an invalid name (2), a tool missing from the index, a checksum
 * mismatch or an unsafe artifact (1), a manifest mismatch (78), or an unsupported platform or
 * held lock (69).
 */
export async function installTool(options: InstallOptions): Promise<void> {
  assertToolName(options.name);
  const entry = await findEntry(options.index, options.name);
  const paths = tbxPaths(options.home, envOf(options));
  await withLock(paths.lockFile, () => installLocked(entry, paths, options), options.lockTimeoutMs);
}

/**
 * Options for `uninstallTool`; `env`, `lockTimeoutMs` and `faultAt` (only `after-aside` applies)
 * mean the same as for `installTool`.
 */
export interface UninstallOptions {
  name: string;
  home: string;
  env?: Env;
  lockTimeoutMs?: number;
  faultAt?: FaultPoint;
}

async function uninstallLocked(options: UninstallOptions, paths: TbxPaths): Promise<void> {
  const { name } = options;
  const state = await readState(paths);
  const toolDir = path.join(paths.tools, name);
  const links = await toolLinks(paths, name);
  const recorded = recordOf(state, name) !== undefined;
  if (!recorded && links.length === 0 && !(await pathExists(toolDir))) {
    throw new ToolError(`${name} is not installed`);
  }
  for (const link of links) await rm(link, { force: true });
  if (recorded) {
    const tools = Object.fromEntries(Object.entries(state.tools).filter(([key]) => key !== name));
    await writeState(paths, { tools });
  }
  await removeAside(toolDir, paths.staging, options);
}

/**
 * Removes `name` under `home` while holding the install lock: every bin link that points into
 * the tool's directory (its name and alias), then its `installed.json` entry (atomically), then every installed
 * version, by renaming the tool directory aside into staging before deleting it, so a kill never
 * leaves a half-deleted directory at its normal path.
 *
 * @throws {ToolError} exit 2 for an invalid name, exit 1 when the tool is not installed.
 */
export async function uninstallTool(options: UninstallOptions): Promise<void> {
  assertToolName(options.name);
  const paths = tbxPaths(options.home, envOf(options));
  await withLock(paths.lockFile, () => uninstallLocked(options, paths), options.lockTimeoutMs);
}

/**
 * The installed tool `word` runs: `word` itself when it has an install record, otherwise the
 * recorded tool whose installed `tool.toml` declares `word` as its alias, otherwise `null`. A
 * version directory whose `tool.toml` is missing is skipped.
 *
 * @throws {ManifestError} when an installed `tool.toml` exists but cannot be read or is invalid.
 */
export async function installedToolFor(paths: TbxPaths, word: string): Promise<string | null> {
  const state = await readState(paths);
  if (recordOf(state, word) !== undefined) return word;
  for (const [name, record] of Object.entries(state.tools)) {
    const file = path.join(paths.tools, name, record.version, 'tool.toml');
    try {
      const manifest = await loadManifest(file);
      if (manifest.alias === word) return name;
    } catch (error) {
      if (!(error instanceof ManifestError && error.code === 'ENOENT')) throw error;
    }
  }
  return null;
}

/** Release index `tbx install` reads when neither `--index` nor `TBX_INDEX` is given. */
export const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/joeblackwaslike/toolbox/release-index/index.json';

/** Default `--index`: `TBX_INDEX` from `env`, else the published release index. */
export function defaultIndex(env: Env): string {
  const override = env.TBX_INDEX;
  return override === undefined || override === '' ? DEFAULT_INDEX_URL : override;
}

/** Turns an `--index` value into a URL, or an absolute path for a local file. */
export function resolveIndex(source: string): string {
  return /^(https?|file):/i.test(source) ? source : path.resolve(source);
}

/** Options for `install`; `lockTimeoutMs` is for library callers and tests, not a CLI flag. */
export interface InstallCommandOptions {
  index?: string;
  lockTimeoutMs?: number;
}

type InstallOutcome =
  | { kind: 'installed'; name: string; version: string }
  | { kind: 'skipped'; name: string }
  | { kind: 'failed'; name: string; error: unknown };

async function installSingle(
  ctx: TbxContext,
  name: string,
  index: string,
  options: InstallCommandOptions,
): Promise<string> {
  await installTool({
    name,
    index,
    home: ctx.home,
    env: ctx.env,
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    warn: (message) => {
      ctx.out.info(message);
    },
  });
  const state = await readState(tbxPaths(ctx.home, ctx.env));
  return recordOf(state, name)?.version ?? '';
}

async function installOne(
  ctx: TbxContext,
  name: string,
  index: string,
  options: InstallCommandOptions,
): Promise<InstallOutcome> {
  try {
    return { kind: 'installed', name, version: await installSingle(ctx, name, index, options) };
  } catch (error) {
    if (error instanceof UnsupportedPlatformError) {
      ctx.out.info(`skipped ${name}: ${error.message}`);
      return { kind: 'skipped', name };
    }
    return { kind: 'failed', name, error };
  }
}

function reportBulk(
  ctx: TbxContext,
  outcomes: InstallOutcome[],
): { name: string; error: unknown }[] {
  const installed = outcomes.flatMap((o) =>
    o.kind === 'installed' ? [{ name: o.name, version: o.version }] : [],
  );
  const skipped = outcomes.flatMap((o) => (o.kind === 'skipped' ? [o.name] : []));
  const failed = outcomes.flatMap((o) => (o.kind === 'failed' ? [o] : []));
  for (const tool of failed) ctx.out.error(`error: ${tool.name}: ${messageOf(tool.error)}`);
  ctx.out.result(
    ctx.json
      ? {
          installed,
          ...(skipped.length > 0 ? { skipped } : {}),
          ...(failed.length > 0 ? { failed: failed.map((tool) => tool.name) } : {}),
        }
      : installed.map((tool) => `installed ${tool.name} ${tool.version}`).join('\n'),
  );
  return failed;
}

function bulkFailure(failed: { name: string; error: unknown }[]): ToolError {
  const [first] = failed;
  const code = first?.error instanceof ToolError ? first.error.code : ExitCode.failure;
  return new ToolError(`install failed: ${failed.map((tool) => tool.name).join(', ')}`, code);
}

/** Every tool name in the index, once each, in first-seen (newest-first) order. */
async function indexNames(index: string): Promise<string[]> {
  const entries = await fetchIndex(index);
  return [...new Set(entries.map((entry) => entry.name))];
}

/**
 * `tbx install <name|all> [--index <path|url>]`: installs one tool, or every tool in the index.
 * With `all`, only a tool that does not support this platform is skipped (and reported); any
 * other failure, such as a lock timeout or a missing unit validator under CI, is printed as
 * `<name>: <message>`, the remaining tools are still attempted, and the command then fails with
 * the first failure's exit code, naming every tool that failed. A single tool's error propagates
 * as is.
 */
export async function install(
  ctx: TbxContext,
  target: string,
  options: InstallCommandOptions,
): Promise<void> {
  const index = resolveIndex(options.index ?? defaultIndex(ctx.env));
  if (target !== 'all') {
    const version = await installSingle(ctx, target, index, options);
    ctx.out.result(
      ctx.json ? { installed: [{ name: target, version }] } : `installed ${target} ${version}`,
    );
    return;
  }
  const outcomes: InstallOutcome[] = [];
  for (const name of await indexNames(index)) {
    outcomes.push(await installOne(ctx, name, index, options));
  }
  const failed = reportBulk(ctx, outcomes);
  if (failed.length > 0) throw bulkFailure(failed);
}

/** `tbx uninstall <name>`: removes an installed tool, its link and its record. */
export async function uninstall(ctx: TbxContext, name: string): Promise<void> {
  await uninstallTool({ name, home: ctx.home, env: ctx.env });
  ctx.out.result(ctx.json ? { uninstalled: name } : `uninstalled ${name}`);
}

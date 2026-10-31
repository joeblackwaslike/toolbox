import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import type { ToolManifest } from '../../../shared/ts/src/manifest.ts';
import { sha256 } from '../archive.ts';
import type { TbxContext } from '../context.ts';
import { ARTIFACT_MARKER, EXECUTABLE, stageArtifact } from '../stage.ts';
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
import { DEFAULT_RELEASE_DIR, type IndexEntry, readIndex } from './build.ts';

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
  /** Path of the release `index.json`. */
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

function artifactPath(index: string, entry: IndexEntry): string {
  const base = path.dirname(path.resolve(index));
  const file = path.resolve(base, entry.artifact);
  if (path.isAbsolute(entry.artifact) || path.relative(base, file).startsWith('..')) {
    throw new ToolError(
      `${index}: artifact for ${entry.name} must stay inside the index directory`,
      ExitCode.config,
    );
  }
  return file;
}

async function findEntry(index: string, name: string): Promise<IndexEntry> {
  const entries = await readIndex(index);
  const entry = entries.find((tool) => tool.name === name);
  if (entry === undefined) throw new ToolError(`${name} is not in ${index}`);
  return entry;
}

async function readText(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8');
    return text.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readLink(file: string): Promise<string | null> {
  try {
    return await readlink(file);
  } catch {
    return null;
  }
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
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
  await mkdir(staging, { recursive: true });
  const aside = await mkdtemp(path.join(staging, 'removed-'));
  await moveDir(dir, path.join(aside, path.basename(dir)));
  fault(options, 'after-aside');
  await rm(aside, { recursive: true, force: true });
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && (info.mode & EXECUTABLE) === EXECUTABLE;
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
  if (installed !== null && (await isExecutableFile(path.join(versionDir, 'bin', entry.name)))) {
    if (installed === entry.sha256) return;
    throw new ToolError(
      `${entry.name} ${entry.version} is already installed from a different artifact; installed versions are immutable, so bump the version or uninstall first`,
    );
  }
  await removeAside(versionDir, staging);
  await mkdir(path.dirname(versionDir), { recursive: true });
  await moveDir(stage, versionDir);
}

async function swapLink(link: string, target: string): Promise<void> {
  const dir = path.dirname(link);
  await mkdir(dir, { recursive: true });
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

async function verifiedBytes(artifact: string, entry: IndexEntry): Promise<Buffer> {
  const bytes = await readFile(artifact);
  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new ToolError(
      `checksum mismatch for ${artifact}: index says ${entry.sha256}, file is ${actual}`,
    );
  }
  return bytes;
}

async function activate(
  m: ToolManifest,
  versionDir: string,
  paths: TbxPaths,
  options: InstallOptions,
): Promise<void> {
  const state = await readState(paths);
  const previous = recordOf(state, m.name);
  const link = path.join(paths.bin, m.name);
  const binary = path.join(versionDir, 'bin', m.name);
  if (previous?.version === m.version && (await readLink(link)) === binary) return;
  await swapLink(link, binary);
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
  artifact: string,
  paths: TbxPaths,
  options: InstallOptions,
): Promise<void> {
  const bytes = await verifiedBytes(artifact, entry);
  await rm(paths.staging, { recursive: true, force: true });
  await mkdir(paths.staging, { recursive: true });
  const stage = await mkdtemp(path.join(paths.staging, `${entry.name}-`));
  try {
    const m = await stageArtifact(bytes, entry, stage, path.join(paths.bin, entry.name), options);
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
  const artifact = artifactPath(options.index, entry);
  const paths = tbxPaths(options.home, envOf(options));
  await withLock(
    paths.lockFile,
    () => installLocked(entry, artifact, paths, options),
    options.lockTimeoutMs,
  );
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
  const link = path.join(paths.bin, name);
  const target = await readLink(link);
  const recorded = recordOf(state, name) !== undefined;
  if (!recorded && target === null && !(await pathExists(toolDir))) {
    throw new ToolError(`${name} is not installed`);
  }
  if (target !== null && !path.relative(toolDir, target).startsWith('..')) {
    await rm(link, { force: true });
  }
  if (recorded) {
    const tools = Object.fromEntries(Object.entries(state.tools).filter(([key]) => key !== name));
    await writeState(paths, { tools });
  }
  await removeAside(toolDir, paths.staging, options);
}

/**
 * Removes `name` under `home` while holding the install lock: the bin link (only when it points
 * into the tool's directory), then its `installed.json` entry (atomically), then every installed
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

/** Default `--index`: `dist/release/index.json` under the repo root. */
export function defaultIndex(root: string): string {
  return path.join(root, DEFAULT_RELEASE_DIR, 'index.json');
}

async function installOne(
  ctx: TbxContext,
  name: string,
  index: string,
  skipUnsupported: boolean,
): Promise<{ name: string; version: string } | null> {
  try {
    await installTool({
      name,
      index,
      home: ctx.home,
      env: ctx.env,
      warn: (message) => {
        ctx.out.info(message);
      },
    });
  } catch (error) {
    if (!(skipUnsupported && error instanceof ToolError && error.code === ExitCode.unavailable)) {
      throw error;
    }
    ctx.out.info(`skipped ${name}: ${error.message}`);
    return null;
  }
  const state = await readState(tbxPaths(ctx.home, ctx.env));
  return { name, version: recordOf(state, name)?.version ?? '' };
}

async function indexNames(index: string): Promise<string[]> {
  const entries = await readIndex(index);
  return entries.map((entry) => entry.name);
}

/**
 * `tbx install <name|all> [--index <path>]`: installs one tool, or every tool in the index;
 * with `all`, a tool that does not support this platform is skipped and reported.
 */
export async function install(
  ctx: TbxContext,
  target: string,
  options: { index?: string },
): Promise<void> {
  const index = path.resolve(options.index ?? defaultIndex(ctx.root));
  const all = target === 'all';
  const names = all ? await indexNames(index) : [target];
  const installed: { name: string; version: string }[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const result = await installOne(ctx, name, index, all);
    if (result === null) skipped.push(name);
    else installed.push(result);
  }
  ctx.out.result(
    ctx.json
      ? { installed, ...(skipped.length > 0 ? { skipped } : {}) }
      : installed.map((tool) => `installed ${tool.name} ${tool.version}`).join('\n'),
  );
}

/** `tbx uninstall <name>`: removes an installed tool, its link and its record. */
export async function uninstall(ctx: TbxContext, name: string): Promise<void> {
  await uninstallTool({ name, home: ctx.home, env: ctx.env });
  ctx.out.result(ctx.json ? { uninstalled: name } : `uninstalled ${name}`);
}

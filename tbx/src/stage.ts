import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ToolError, messageOf } from '../../shared/ts/src/errors.ts';
import {
  renderSystemdTimer,
  renderUnit,
  unitLabel,
  validateUnit,
} from '../../shared/ts/src/gen/unit.ts';
import { ManifestError, type ToolManifest, parseManifest } from '../../shared/ts/src/manifest.ts';
import { EXECUTABLE_MODE, READABLE_MODE } from '../../shared/ts/src/paths.ts';
import { type TarMember, unpackTar } from './archive.ts';
import type { IndexEntry } from './commands/build.ts';
import { isCi } from './context.ts';
import type { Env } from './state.ts';

/** File in each version directory holding the sha256 of the artifact it came from. */
export const ARTIFACT_MARKER = 'artifact.sha256';
const MANIFEST_FILE = 'tool.toml';
const REGULAR_FILE = '0';
/** The `platforms` value of the machine this runs on. */
export const CURRENT_PLATFORM = process.platform === 'darwin' ? 'macos' : 'linux';

/** What `stageArtifact` reads from the install options. */
export interface StageOptions {
  /** Home directory rendered into unit files. */
  home: string;
  /** Environment for `CI`; defaults to `process.env`. */
  env?: Env;
  /** Receives a skipped-validator warning; defaults to stderr. */
  warn?: (message: string) => void;
}

function unpack(bytes: Buffer): TarMember[] {
  try {
    return unpackTar(bytes);
  } catch (error) {
    throw new ToolError(`artifact is not a valid .tar.gz: ${messageOf(error)}`);
  }
}

function checkMembers(members: TarMember[], name: string): Map<string, Buffer> {
  const allowed = new Set([`bin/${name}`, MANIFEST_FILE]);
  const files = new Map<string, Buffer>();
  for (const member of members) {
    if (member.type !== REGULAR_FILE || !allowed.has(member.path) || files.has(member.path)) {
      throw new ToolError(
        `artifact member "${member.path}" (type ${member.type ?? '?'}) is not allowed; an artifact holds only bin/${name} and ${MANIFEST_FILE} as regular files`,
      );
    }
    files.set(member.path, member.content);
  }
  for (const required of allowed) {
    if (!files.has(required)) throw new ToolError(`artifact is missing ${required}`);
  }
  return files;
}

function parseArtifactManifest(text: string): ToolManifest {
  try {
    return parseManifest(text);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new ToolError(`artifact ${MANIFEST_FILE}: ${error.message}`, ExitCode.config);
    }
    throw error;
  }
}

function artifactManifest(text: string, entry: IndexEntry): ToolManifest {
  const m = parseArtifactManifest(text);
  if (m.name !== entry.name || m.version !== entry.version) {
    throw new ToolError(
      `artifact ${MANIFEST_FILE} is ${m.name} version ${m.version}, index says ${entry.name} version ${entry.version}`,
      ExitCode.config,
    );
  }
  if (!m.platforms.includes(CURRENT_PLATFORM)) {
    throw new ToolError(
      `${m.name} does not support ${CURRENT_PLATFORM} (platforms: ${m.platforms.join(', ')})`,
      ExitCode.unavailable,
    );
  }
  return m;
}

/**
 * Renders the unit files a tool installs on this platform for `binPath` and `home`, as
 * `[file name, content]` pairs: a launchd plist on macOS; a systemd service, plus a timer for
 * a `schedule` unit, on Linux.
 *
 * @throws {Error} the errors of `renderUnit` (no `[unit]`, or this platform not supported).
 */
export function unitFiles(m: ToolManifest, binPath: string, home: string): [string, string][] {
  const label = unitLabel(m);
  const ctx = { binPath, home, label };
  if (CURRENT_PLATFORM === 'macos') return [[`${label}.plist`, renderUnit(m, 'launchd', ctx)]];
  const service: [string, string] = [`${label}.service`, renderUnit(m, 'systemd', ctx)];
  return m.unit?.kind === 'schedule'
    ? [service, [`${label}.timer`, renderSystemdTimer(m, ctx)]]
    : [service];
}

/**
 * Validates the unit rendered for `stagedBin`, then writes the files rendered for `binPath`.
 * `systemd-analyze verify` rejects an ExecStart that does not exist, and the managed bin link
 * at `binPath` only appears at activation; the two renderings differ only in that path.
 */
async function renderUnits(
  m: ToolManifest,
  stage: string,
  stagedBin: string,
  binPath: string,
  options: StageOptions,
): Promise<void> {
  if (m.unit === undefined) return;
  const files = unitFiles(m, binPath, options.home);
  const [primary] = unitFiles(m, stagedBin, options.home);
  const result = await validateUnit(
    CURRENT_PLATFORM === 'macos' ? 'launchd' : 'systemd',
    primary?.[1] ?? '',
  );
  if (!result.ok) {
    throw new ToolError(`unit for ${m.name} is invalid: ${result.message}`, ExitCode.config);
  }
  if (result.skipped) {
    if (isCi(options.env ?? process.env)) {
      throw new ToolError(
        `cannot validate the unit for ${m.name}: ${result.message}`,
        ExitCode.unavailable,
      );
    }
    const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(`warning: unit for ${m.name} not validated: ${result.message}`);
  }
  await mkdir(path.join(stage, 'units'), { mode: EXECUTABLE_MODE });
  for (const [file, content] of files) {
    await writeFile(path.join(stage, 'units', file), content, { flag: 'wx', mode: READABLE_MODE });
  }
}

/**
 * Validates an artifact and writes it into the empty directory `stage`: only `bin/<name>` and
 * `tool.toml` as regular files are accepted, the manifest must match `entry` and support this
 * platform, then the binary (0755), the manifest, an `artifact.sha256` marker and any unit files
 * (rendered for `binPath`, never activated) are written. Nothing is written before every member
 * has been checked.
 *
 * @throws {ToolError} for an unsafe or malformed artifact (1), a manifest mismatch or invalid
 * unit (78), or an unsupported platform or a unit validator missing under CI (69).
 */
export async function stageArtifact(
  bytes: Buffer,
  entry: IndexEntry,
  stage: string,
  binPath: string,
  options: StageOptions,
): Promise<ToolManifest> {
  const files = checkMembers(unpack(bytes), entry.name);
  const toml = files.get(MANIFEST_FILE) ?? Buffer.alloc(0);
  const m = artifactManifest(toml.toString('utf8'), entry);
  await mkdir(path.join(stage, 'bin'), { mode: EXECUTABLE_MODE });
  const bin = path.join(stage, 'bin', entry.name);
  await writeFile(bin, files.get(`bin/${entry.name}`) ?? Buffer.alloc(0), { flag: 'wx' });
  await chmod(bin, EXECUTABLE_MODE);
  await writeFile(path.join(stage, MANIFEST_FILE), toml, { flag: 'wx', mode: READABLE_MODE });
  await writeFile(path.join(stage, ARTIFACT_MARKER), `${entry.sha256}\n`, {
    flag: 'wx',
    mode: READABLE_MODE,
  });
  await renderUnits(m, stage, bin, binPath, options);
  return m;
}

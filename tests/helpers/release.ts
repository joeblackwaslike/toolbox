import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TarMember, packTar, sha256 } from '../../tbx/src/archive.ts';
import { writeIndex } from '../../tbx/src/commands/build.ts';

/** Name of the hand-built shell tool the install tests publish. */
export const TOOL = 'hello';

/** A `tool.toml` for `TOOL` at `version`, with `extra` TOML appended. */
export function manifestText(version: string, extra = ''): string {
  return [
    `name = "${TOOL}"`,
    'summary = "Says hello"',
    'language = "sh"',
    `version = "${version}"`,
    'platforms = ["macos", "linux"]',
    extra,
  ].join('\n');
}

/** The two members of a well-formed `TOOL` artifact whose binary prints `hello <version>`. */
export function members(version: string, extra = ''): TarMember[] {
  return [
    {
      path: `bin/${TOOL}`,
      content: Buffer.from(`#!/bin/sh\necho "hello ${version}"\n`),
      mode: 0o755,
    },
    { path: 'tool.toml', content: Buffer.from(manifestText(version, extra)), mode: 0o644 },
  ];
}

/** Temp directories for one install test: a fake HOME and a release output directory. */
export interface Sandbox {
  home: string;
  releases: string;
}

/** Creates a fresh `Sandbox` under the OS temp directory. */
export async function sandbox(): Promise<Sandbox> {
  return {
    home: await mkdtemp(join(tmpdir(), 'tbx-home-')),
    releases: await mkdtemp(join(tmpdir(), 'tbx-rel-')),
  };
}

/**
 * Writes `<releases>/hello-<version>.tar.gz` (from `content`, or packed from `parts`) and an
 * `index.json` listing only it, with the checksum of the bytes written. Returns the index path.
 */
export async function publish(
  box: Sandbox,
  version: string,
  parts: TarMember[] | Buffer = members(version),
): Promise<string> {
  const bytes = Buffer.isBuffer(parts) ? parts : packTar(parts);
  const artifact = `${TOOL}-${version}.tar.gz`;
  await writeFile(join(box.releases, artifact), bytes);
  return writeIndex(box.releases, [{ name: TOOL, version, artifact, sha256: sha256(bytes) }]);
}

/** Flips one byte of the published artifact for `version`, leaving the index untouched. */
export async function tamper(box: Sandbox, version: string): Promise<void> {
  const file = join(box.releases, `${TOOL}-${version}.tar.gz`);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  await writeFile(file, bytes);
}

/** Paths an install into `home` uses when no XDG variable or `TBX_BIN_DIR` is set. */
export function layout(home: string): {
  tools: string;
  link: string;
  state: string;
  lock: string;
  staging: string;
} {
  const data = join(home, '.local/share/tbx');
  const state = join(home, '.local/state/tbx');
  return {
    tools: join(data, 'tools', TOOL),
    link: join(data, 'bin', TOOL),
    state: join(state, 'installed.json'),
    lock: join(state, 'install.lock'),
    staging: join(data, 'staging'),
  };
}

/** Runs `file` with no arguments and returns its trimmed stdout. */
export function runBinary(file: string): string {
  return execFileSync(file, { encoding: 'utf8' }).trim();
}

/** True when `file` exists, following symlinks. */
export async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

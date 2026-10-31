import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ToolError, isErrnoException } from '../../shared/ts/src/errors.ts';
import type { ToolManifest } from '../../shared/ts/src/manifest.ts';
import { isWithin } from '../../shared/ts/src/paths.ts';
import type { TbxPaths } from './state.ts';

async function readLink(file: string): Promise<string | null> {
  try {
    return await readlink(file);
  } catch {
    return null;
  }
}

/** The bin link names a tool needs: its name, then its alias when it has one. */
export function identifiers(m: ToolManifest): string[] {
  return m.alias === undefined ? [m.name] : [m.name, m.alias];
}

async function linkTarget(link: string): Promise<string | null | undefined> {
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) return null;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return path.resolve(path.dirname(link), await readlink(link));
}

/**
 * Refuses unless every link `m` needs (`bin/<name>` and `bin/<alias>`) is missing or is a
 * symlink into this tool's own directory, so a file the user put in a shared bin directory, or
 * another installed tool's link, is never replaced.
 */
export async function assertLinksOwned(m: ToolManifest, paths: TbxPaths): Promise<void> {
  const toolDir = path.join(paths.tools, m.name);
  for (const identifier of identifiers(m)) {
    const link = path.join(paths.bin, identifier);
    const target = await linkTarget(link);
    if (target === undefined || (target !== null && isWithin(toolDir, target))) continue;
    const owner =
      target !== null && isWithin(paths.tools, target)
        ? `it links to another installed tool (${path.relative(paths.tools, target).split(path.sep)[0] ?? ''})`
        : 'it is not a tbx link';
    throw new ToolError(
      `cannot link ${identifier} for ${m.name}: ${link} exists and ${owner}; remove it or set TBX_BIN_DIR to another directory`,
      ExitCode.config,
    );
  }
}

/** The links in the bin directory that point into `tools/<name>/`. */
export async function toolLinks(paths: TbxPaths, name: string): Promise<string[]> {
  const toolDir = path.join(paths.tools, name);
  let entries: string[];
  try {
    entries = await readdir(paths.bin);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const links: string[] = [];
  for (const entry of entries) {
    const link = path.join(paths.bin, entry);
    const target = await linkTarget(link);
    if (typeof target === 'string' && isWithin(toolDir, target)) links.push(link);
  }
  return links;
}

/** True when every link `m` needs already points at `binary`. */
export async function linksCurrent(
  m: ToolManifest,
  paths: TbxPaths,
  binary: string,
): Promise<boolean> {
  for (const identifier of identifiers(m)) {
    if ((await readLink(path.join(paths.bin, identifier))) !== binary) return false;
  }
  return true;
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ToolError, isErrnoException } from '../../../shared/ts/src/errors.ts';
import { compareText } from '../../../shared/ts/src/gen/files.ts';
import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import type { TbxContext } from '../context.ts';
import { writeFileAtomic } from '../state.ts';
import { bundledSharedFiles, tbxSharedFiles } from './build.ts';

/** Bump when a change to the build or generators alters shipped output without touching `shared/`. */
export const STAMP_GENERATOR_VERSION = '1';

const STAMP_FILE = '.shared-stamp';
const TBX_COMPONENT = 'tbx-cli';
const TBX_DIR = 'tbx';

/** Outcome of stamping one component. */
export interface StampResult {
  component: string;
  changed: boolean;
}

async function sharedFilesOf(root: string, component: string): Promise<string[]> {
  if (component === TBX_COMPONENT) return tbxSharedFiles(root);
  const manifests = await loadToolManifests(root);
  const manifest = manifests.find((m) => m.name === component);
  if (manifest === undefined) throw new ToolError(`no component "${component}"`, ExitCode.usage);
  return bundledSharedFiles(root, manifest);
}

/**
 * SHA-256 over `generator` and the sorted relative paths and contents of exactly the `shared/`
 * files the build of `component` (a tool name, or `tbx-cli` for `tbx/`) bundles.
 *
 * @throws {ToolError} exit 2 when `component` is unknown.
 */
export async function computeStamp(
  root: string,
  component: string,
  generator = STAMP_GENERATOR_VERSION,
): Promise<string> {
  const files = [...new Set(await sharedFilesOf(root, component))].sort(compareText);
  const hash = createHash('sha256').update(`generator ${generator}\n`);
  for (const file of files) {
    hash
      .update(`${file}\0`)
      .update(await readFile(path.join(root, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

async function readStamp(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Recomputes the stamp of every tool under `tools/` and of `tbx/` (named `tbx-cli`), in that
 * order, and reports which differ from the `.shared-stamp` on disk. With `write`, the stale
 * stamps are rewritten.
 */
export async function stampAll(root: string, write: boolean): Promise<StampResult[]> {
  const manifests = await loadToolManifests(root);
  const components = [...manifests.map((m) => m.name), TBX_COMPONENT];
  const results: StampResult[] = [];
  for (const component of components) {
    const dir = component === TBX_COMPONENT ? TBX_DIR : path.join('tools', component);
    const file = path.join(root, dir, STAMP_FILE);
    const text = `${await computeStamp(root, component)}\n`;
    const changed = (await readStamp(file)) !== text;
    if (changed && write) await writeFileAtomic(file, text);
    results.push({ component, changed });
  }
  return results;
}

/**
 * `tbx stamp --write|--check`: prints the components whose stamp is stale, one per line (written
 * with `--write`). `--check` writes nothing and exits 1 when any is stale.
 *
 * @throws {ToolError} exit 1 under `--check` when a stamp is stale, exit 2 without exactly one flag.
 */
export async function stamp(
  ctx: TbxContext,
  options: { write?: boolean; check?: boolean },
): Promise<void> {
  if ((options.write === true) === (options.check === true)) {
    throw new ToolError('pass exactly one of --write or --check', ExitCode.usage);
  }
  const results = await stampAll(ctx.root, options.write === true);
  const changed = results.filter((r) => r.changed).map((r) => r.component);
  ctx.out.result(ctx.json ? { changed } : changed.join('\n'));
  if (options.check === true && changed.length > 0) {
    throw new ToolError('shared stamps are stale', ExitCode.failure);
  }
}

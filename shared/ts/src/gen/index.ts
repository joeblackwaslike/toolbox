import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrnoException } from '../errors.ts';
import { ManifestError, loadManifest } from '../manifest.ts';
import type { ToolManifest } from '../manifest.ts';
import { renderCompletions } from './completions.ts';
import { type GeneratedFile, compareText } from './files.ts';
import { renderCatalog, renderToolReadme } from './readme.ts';
import {
  type SharedModuleDoc,
  extractSharedDocs,
  missingSharedDocs,
  renderSharedDocs,
} from './shared-docs.ts';

const SHELLS = ['zsh', 'bash', 'fish'] as const;
const UNDOCUMENTED_PREFIX = 'undocumented: ';

export type { GeneratedFile } from './files.ts';

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stats = await stat(target);
    return stats.isDirectory();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadToolManifest(root: string, entry: string): Promise<ToolManifest | null> {
  const file = path.join(root, 'tools', entry, 'tool.toml');
  let manifest: ToolManifest;
  try {
    manifest = await loadManifest(file);
  } catch (error) {
    if (error instanceof ManifestError && error.code === 'ENOENT') return null;
    throw error;
  }
  if (manifest.name !== entry) {
    throw new ManifestError(
      `${file}: name "${manifest.name}" must match its directory "${entry}"`,
      'name',
    );
  }
  return manifest;
}

/**
 * Loads every `tools/<name>/tool.toml` under `root`, sorted by directory name. A directory
 * without a `tool.toml` and a plain file under `tools/` are skipped; a missing `tools/` gives
 * `[]`.
 *
 * @throws {ManifestError} when a `tool.toml` cannot be read for any reason other than not
 * existing, is invalid, or names a tool other than its directory.
 */
export async function loadToolManifests(root: string): Promise<ToolManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(root, 'tools'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const manifests: ToolManifest[] = [];
  for (const entry of [...entries].sort(compareText)) {
    if (!(await isDirectory(path.join(root, 'tools', entry)))) continue;
    const manifest = await loadToolManifest(root, entry);
    if (manifest !== null) manifests.push(manifest);
  }
  return manifests;
}

function section(title: string, entries: string[]): string[] {
  return entries.length === 0 ? [] : [`## ${title}`, '', ...entries, ''];
}

function renderLlms(ms: ToolManifest[], mods: SharedModuleDoc[]): string {
  const tools = [...ms]
    .sort((a, b) => compareText(a.name, b.name))
    .map((m) => `- [${m.name}](tools/${m.name}/README.md): ${m.summary}`);
  const shared = mods.map(
    (mod) =>
      `- [${mod.lang}/${mod.module}](docs/shared/${mod.lang}/${mod.module}.md): ${mod.symbols.map((symbol) => symbol.name).join(', ')}`,
  );
  return [
    '# tbx',
    '',
    '> A toolbox of small command line tools with shared runtime helpers.',
    '',
    ...section('Docs', [
      '- [Tool catalog](docs/catalog.md): every tool with its alias, language and summary',
      '- [Shared modules](docs/shared/index.md): helpers every tool reuses',
    ]),
    ...section('Tools', tools),
    ...section('Shared modules', shared),
  ].join('\n');
}

/**
 * Renders every generated file for the repo at `root`: per-tool README and completions from
 * `tools/<name>/tool.toml`, `docs/catalog.md`, `docs/llms.txt`, and the shared module pages.
 * Output is deterministic and sorted by path.
 */
export async function generateAll(root: string): Promise<GeneratedFile[]> {
  return buildFiles(root, await loadToolManifests(root), await extractSharedDocs(root));
}

async function buildFiles(
  root: string,
  manifests: ToolManifest[],
  mods: SharedModuleDoc[],
): Promise<GeneratedFile[]> {
  const guides = new Set<string>();
  for (const m of manifests) {
    if ((await readIfPresent(path.join(root, 'tools', m.name, 'docs/guide.md'))) !== null) {
      guides.add(m.name);
    }
  }
  const files: GeneratedFile[] = [
    ...manifests.flatMap((m) => [
      {
        path: `tools/${m.name}/README.md`,
        content: renderToolReadme(m, { hasGuide: guides.has(m.name) }),
      },
      ...SHELLS.map((shell) => ({
        path: `tools/${m.name}/completions/${m.name}.${shell}`,
        content: renderCompletions(m, shell),
      })),
    ]),
    { path: 'docs/catalog.md', content: renderCatalog(manifests) },
    { path: 'docs/llms.txt', content: renderLlms(manifests, mods) },
    ...renderSharedDocs(mods),
  ];
  return files.sort((a, b) => compareText(a.path, b.path));
}

/** Writes generated files under `root`, creating directories as needed. */
export async function writeGenerated(root: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
}

async function filesBelow(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function existingGenerated(root: string, manifests: ToolManifest[]): Promise<string[]> {
  const found = [path.join(root, 'docs/catalog.md'), path.join(root, 'docs/llms.txt')];
  found.push(...(await filesBelow(path.join(root, 'docs/shared'))));
  for (const { name } of manifests) {
    found.push(
      path.join(root, 'tools', name, 'README.md'),
      ...(await filesBelow(path.join(root, 'tools', name, 'completions'))),
    );
  }
  const present: string[] = [];
  for (const file of found) {
    if ((await readIfPresent(file)) !== null) present.push(path.relative(root, file));
  }
  return present;
}

async function staleFiles(
  root: string,
  manifests: ToolManifest[],
  files: GeneratedFile[],
): Promise<string[]> {
  const generated = new Set(files.map((file) => file.path));
  const existing = await existingGenerated(root, manifests);
  return existing.filter((file) => !generated.has(file)).sort(compareText);
}

/**
 * Writes `generateAll(root)` and deletes stale generated files: anything under
 * `tools/<name>/completions/` of a tool with a valid `tool.toml`, under `docs/shared/`, or
 * `docs/catalog.md` and `docs/llms.txt`, that is no longer generated. A `tools/<dir>/` without
 * a `tool.toml` and files outside those roots are never touched. Returns the deleted paths.
 *
 * @throws {ManifestError} before writing anything when a manifest is unreadable or invalid.
 */
export async function syncGenerated(root: string): Promise<string[]> {
  const manifests = await loadToolManifests(root);
  const files = await buildFiles(root, manifests, await extractSharedDocs(root));
  await writeGenerated(root, files);
  const stale = await staleFiles(root, manifests, files);
  for (const file of stale) await rm(path.join(root, file));
  return stale;
}

function undocumentedOf(mods: SharedModuleDoc[]): string[] {
  return missingSharedDocs(mods).map((symbol) => `${UNDOCUMENTED_PREFIX}${symbol}`);
}

/** Lists public shared symbols without a doc comment as `undocumented: <lang>/<module>.<name>`. */
export async function undocumentedSymbols(root: string): Promise<string[]> {
  return undocumentedOf(await extractSharedDocs(root));
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Returns the paths whose on-disk content differs from `generateAll(root)` (a missing file
 * counts), then generated files that are no longer produced (see `syncGenerated`), then one `undocumented: <lang>/<module>.<name>` entry per public shared
 * symbol with no doc comment. An empty result means nothing has drifted.
 */
export async function checkDrift(root: string): Promise<string[]> {
  const manifests = await loadToolManifests(root);
  const mods = await extractSharedDocs(root);
  const files = await buildFiles(root, manifests, mods);
  const drifted: string[] = [];
  for (const file of files) {
    if ((await readIfPresent(path.join(root, file.path))) !== file.content) drifted.push(file.path);
  }
  return [...drifted, ...(await staleFiles(root, manifests, files)), ...undocumentedOf(mods)];
}

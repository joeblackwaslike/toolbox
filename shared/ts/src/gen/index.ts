import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrnoException } from '../errors.ts';
import { ManifestError, loadManifest } from '../manifest.ts';
import type { ToolManifest } from '../manifest.ts';
import { EXECUTABLE_MODE } from '../paths.ts';
import { renderCompletions } from './completions.ts';
import { GENERATED_MARKER, type GeneratedFile, compareText } from './files.ts';
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
    await mkdir(path.dirname(path.join(root, file.path)), {
      recursive: true,
      mode: EXECUTABLE_MODE,
    });
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

const MARKER_LINES = 3;

function hasMarker(text: string): boolean {
  return text.split('\n', MARKER_LINES).some((line) => line.includes(GENERATED_MARKER));
}

async function toolDirectories(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(root, 'tools'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    const info = await lstat(path.join(root, 'tools', entry));
    if (info.isDirectory()) directories.push(entry);
  }
  return directories;
}

/**
 * True when `file` is a regular file reached without any symlink below `root`, so a stale-file
 * deletion can never land outside the generated roots.
 */
async function isPlainFile(root: string, file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return false;
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    return realFile === path.join(realRoot, path.relative(root, file));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function markedToolFiles(root: string, tool: string): Promise<string[]> {
  const candidates = [
    path.join(root, 'tools', tool, 'README.md'),
    ...(await filesBelow(path.join(root, 'tools', tool, 'completions'))),
  ];
  const marked: string[] = [];
  for (const file of candidates) {
    if (!(await isPlainFile(root, file))) continue;
    const text = await readIfPresent(file);
    if (text !== null && hasMarker(text)) marked.push(path.relative(root, file));
  }
  return marked;
}

async function existingGenerated(root: string): Promise<string[]> {
  const present: string[] = [];
  for (const file of ['docs/catalog.md', 'docs/llms.txt']) {
    if ((await readIfPresent(path.join(root, file))) !== null) present.push(file);
  }
  for (const file of await filesBelow(path.join(root, 'docs/shared'))) {
    if (await isPlainFile(root, file)) present.push(path.relative(root, file));
  }
  for (const tool of await toolDirectories(root))
    present.push(...(await markedToolFiles(root, tool)));
  return present;
}

async function staleFiles(root: string, files: GeneratedFile[]): Promise<string[]> {
  const generated = new Set(files.map((file) => file.path));
  const existing = await existingGenerated(root);
  return existing.filter((file) => !generated.has(file)).sort(compareText);
}

/**
 * Writes `generateAll(root)` and deletes stale generated files that are no longer produced:
 * anything under `docs/shared/`, and a `tools/<dir>/README.md` or `tools/<dir>/completions/*`
 * whose first three lines carry `GENERATED_MARKER` (so a removed tool's generated files go, and
 * hand-written files stay). A file reached through a symlink is never a candidate, and files
 * outside those roots are never touched. Returns the deleted
 * paths.
 *
 * @throws {ManifestError} before writing anything when a manifest is unreadable or invalid.
 */
export async function syncGenerated(root: string): Promise<string[]> {
  const manifests = await loadToolManifests(root);
  const files = await buildFiles(root, manifests, await extractSharedDocs(root));
  await writeGenerated(root, files);
  const stale = await staleFiles(root, files);
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
  return [...drifted, ...(await staleFiles(root, files)), ...undocumentedOf(mods)];
}

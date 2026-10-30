import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from '../manifest.ts';
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

async function loadAll(root: string): Promise<ToolManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(root, 'tools'));
  } catch {
    return [];
  }
  const manifests: ToolManifest[] = [];
  for (const entry of [...entries].sort(compareText)) {
    try {
      manifests.push(await loadManifest(path.join(root, 'tools', entry, 'tool.toml')));
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('cannot read file'))) throw error;
    }
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
  return buildFiles(root, await extractSharedDocs(root));
}

async function buildFiles(root: string, mods: SharedModuleDoc[]): Promise<GeneratedFile[]> {
  const manifests = await loadAll(root);
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
  } catch {
    return [];
  }
}

async function toolDirectories(root: string): Promise<string[]> {
  try {
    return await readdir(path.join(root, 'tools'));
  } catch {
    return [];
  }
}

async function existingGenerated(root: string): Promise<string[]> {
  const found = [path.join(root, 'docs/catalog.md'), path.join(root, 'docs/llms.txt')];
  found.push(...(await filesBelow(path.join(root, 'docs/shared'))));
  for (const tool of await toolDirectories(root)) {
    found.push(
      path.join(root, 'tools', tool, 'README.md'),
      ...(await filesBelow(path.join(root, 'tools', tool, 'completions'))),
    );
  }
  const present: string[] = [];
  for (const file of found) {
    if ((await readIfPresent(file)) !== null) present.push(path.relative(root, file));
  }
  return present;
}

async function staleFiles(root: string, files: GeneratedFile[]): Promise<string[]> {
  const generated = new Set(files.map((file) => file.path));
  const existing = await existingGenerated(root);
  return existing.filter((file) => !generated.has(file)).sort(compareText);
}

/**
 * Writes `generateAll(root)` and deletes stale generated files: anything under
 * `tools/<name>/README.md`, `tools/<name>/completions/`, `docs/shared/`, `docs/catalog.md` or
 * `docs/llms.txt` that is no longer generated. Files outside those roots are never touched.
 * Returns the deleted paths.
 */
export async function syncGenerated(root: string): Promise<string[]> {
  const files = await generateAll(root);
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
  const mods = await extractSharedDocs(root);
  const files = await buildFiles(root, mods);
  const drifted: string[] = [];
  for (const file of files) {
    if ((await readIfPresent(path.join(root, file.path))) !== file.content) drifted.push(file.path);
  }
  return [...drifted, ...(await staleFiles(root, files)), ...undocumentedOf(mods)];
}

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

function renderLlms(ms: ToolManifest[], mods: SharedModuleDoc[]): string {
  const tools = [...ms]
    .sort((a, b) => compareText(a.name, b.name))
    .map((m) => `- ${m.name}: ${m.summary} (tools/${m.name}/README.md)`);
  const shared = mods.map(
    (mod) => `- ${mod.lang}/${mod.module} (docs/shared/${mod.lang}/${mod.module}.md)`,
  );
  return [
    '# tbx',
    '',
    '> A toolbox of small command line tools with shared runtime helpers.',
    '',
    '## Tools',
    '',
    ...tools,
    '',
    '## Shared modules',
    '',
    ...shared,
    '',
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
  const files: GeneratedFile[] = [
    ...manifests.flatMap((m) => [
      { path: `tools/${m.name}/README.md`, content: renderToolReadme(m) },
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
 * counts), followed by one `undocumented: <lang>/<module>.<name>` entry per public shared
 * symbol with no doc comment. An empty result means nothing has drifted.
 */
export async function checkDrift(root: string): Promise<string[]> {
  const mods = await extractSharedDocs(root);
  const drifted: string[] = [];
  for (const file of await buildFiles(root, mods)) {
    if ((await readIfPresent(path.join(root, file.path))) !== file.content) drifted.push(file.path);
  }
  return [...drifted, ...undocumentedOf(mods)];
}

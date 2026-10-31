import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runBounded } from '../run.ts';
import { type GeneratedFile, compareText } from './files.ts';

/** Longest the Python doc extractor may run before doc generation fails. */
export const DOC_EXTRACT_TIMEOUT_MS = 120_000;
const PY_EXTRACTOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../py/extract_docs.py',
);
const TS_DIRS = ['shared/ts/src', 'shared/sh'];
const PY_DIR = 'shared/py/tbx_shared';
const SH_DIR = 'shared/sh';
const SHELL_FUNCTION = /^([A-Za-z]\w*)\(\)\s*\{/;
const FENCE_LANG = { ts: 'ts', py: 'python', sh: 'bash' } as const;
const LANG_ORDER = ['ts', 'py', 'sh'] as const;

/** One documented public symbol of a shared module. `doc` is empty when it has no comment. */
export interface SharedSymbol {
  name: string;
  signature: string;
  doc: string;
}

/** The public symbols of one shared module in one language, sorted by name. */
export interface SharedModuleDoc {
  lang: 'ts' | 'py' | 'sh';
  module: string;
  symbols: SharedSymbol[];
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareText(a.name, b.name);
}

async function filesUnder(dir: string, extension: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort(compareText);
}

function stripJsDoc(raw: string): string {
  return raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim();
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function collapse(text: string): string {
  return text
    .replace(/^export\s+/, '')
    .replaceAll(/\s+/g, ' ')
    .replace(/;$/, '')
    .trim();
}

function docOf(node: ts.Node): string {
  const comments = ts.getJSDocCommentsAndTags(node).filter((comment) => ts.isJSDoc(comment));
  const last = comments.at(-1);
  return last === undefined ? '' : stripJsDoc(last.getText());
}

function tsSymbols(node: ts.Statement, source: ts.SourceFile): SharedSymbol[] {
  if (!isExported(node)) return [];
  const doc = docOf(node);
  const head = (end: number): string => collapse(source.text.slice(node.getStart(source), end));
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    const end = node.body?.getStart(source) ?? node.end;
    return [{ name: node.name.text, signature: head(end), doc }];
  }
  if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name !== undefined) {
    const brace = source.text.indexOf('{', node.name.end);
    return [{ name: node.name.text, signature: head(brace), doc }];
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return [{ name: node.name.text, signature: head(node.end), doc }];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => {
      if (!ts.isIdentifier(declaration.name)) return [];
      const type =
        declaration.type === undefined ? '' : `: ${collapse(declaration.type.getText(source))}`;
      return [
        { name: declaration.name.text, signature: `const ${declaration.name.text}${type}`, doc },
      ];
    });
  }
  return [];
}

async function extractTs(root: string): Promise<SharedModuleDoc[]> {
  const mods: SharedModuleDoc[] = [];
  for (const dir of TS_DIRS) {
    for (const file of await filesUnder(path.join(root, dir), '.ts')) {
      const source = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
      );
      const symbols = source.statements.flatMap((node) => tsSymbols(node, source)).sort(byName);
      const base = path.join(root, dir);
      const module = path.relative(base, file).replace(/\.ts$/, '');
      if (symbols.length > 0) mods.push({ lang: 'ts', module, symbols });
    }
  }
  return mods;
}

async function extractPy(root: string): Promise<SharedModuleDoc[]> {
  const dir = path.join(root, PY_DIR);
  const pyFiles = await filesUnder(dir, '.py');
  if (pyFiles.length === 0) return [];
  const result = await runBounded(
    'uv',
    ['run', '--no-project', 'python', '-I', PY_EXTRACTOR, dir],
    {
      timeoutMs: DOC_EXTRACT_TIMEOUT_MS,
    },
  );
  const parsed = JSON.parse(result.stdout) as { module: string; symbols: SharedSymbol[] }[];
  return parsed.map((mod) => ({ lang: 'py', ...mod }));
}

function shellDoc(commentLines: string[]): string {
  return commentLines
    .map((line) => line.replace(/^#\s?/, '').replace(/^@description\s*/, ''))
    .join('\n')
    .trim();
}

function shellSymbols(text: string): SharedSymbol[] {
  const lines = text.split('\n');
  const symbols: SharedSymbol[] = [];
  let comments: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) {
      comments.push(line);
      continue;
    }
    const match = SHELL_FUNCTION.exec(line);
    if (match?.[1] !== undefined && !match[1].startsWith('_')) {
      symbols.push({ name: match[1], signature: `${match[1]}()`, doc: shellDoc(comments) });
    }
    comments = [];
  }
  return symbols.sort(byName);
}

async function extractSh(root: string): Promise<SharedModuleDoc[]> {
  const dir = path.join(root, SH_DIR);
  const mods: SharedModuleDoc[] = [];
  for (const file of await filesUnder(dir, '.sh')) {
    const symbols = shellSymbols(await readFile(file, 'utf8'));
    if (symbols.length > 0) {
      mods.push({ lang: 'sh', module: path.relative(dir, file).replace(/\.sh$/, ''), symbols });
    }
  }
  return mods;
}

function order(a: SharedModuleDoc, b: SharedModuleDoc): number {
  const key = (mod: SharedModuleDoc): string => `${mod.module}\0${mod.lang}`;
  return compareText(key(a), key(b));
}

/**
 * Reads the public symbols and their doc comments from the shared modules under `root`: TSDoc
 * in `shared/ts/src` and `shared/sh`, docstrings in `shared/py/tbx_shared` (through
 * `shared/py/extract_docs.py` run with `uv`), and shdoc header blocks in `shared/sh/*.sh`.
 * Public means exported in TypeScript and without a leading underscore in Python and shell.
 * Directories that do not exist are skipped. Modules sort by name, symbols by name.
 */
export async function extractSharedDocs(root: string): Promise<SharedModuleDoc[]> {
  const parts = await Promise.all([extractTs(root), extractPy(root), extractSh(root)]);
  return parts.flat().sort(order);
}

/** Lists public symbols that have no doc comment as `<lang>/<module>.<symbol>`. */
export function missingSharedDocs(mods: SharedModuleDoc[]): string[] {
  return mods.flatMap((mod) =>
    mod.symbols
      .filter((symbol) => symbol.doc.trim() === '')
      .map((symbol) => `${mod.lang}/${mod.module}.${symbol.name}`),
  );
}

function tagsAsList(doc: string): string {
  return doc
    .split('\n')
    .map((line) => (line.startsWith('@') ? `- ${line}` : line))
    .join('\n');
}

function renderModulePage(mod: SharedModuleDoc): GeneratedFile {
  const fence = FENCE_LANG[mod.lang];
  const sections = mod.symbols.map(
    (symbol) =>
      `## ${symbol.name}\n\n\`\`\`${fence}\n${symbol.signature}\n\`\`\`\n\n${tagsAsList(symbol.doc)}\n`,
  );
  const content = [
    `# ${mod.lang}/${mod.module}`,
    '',
    '<!-- Generated by `tbx gen` from source doc comments. Do not edit. -->',
    '',
    ...sections,
  ].join('\n');
  return { path: `docs/shared/${mod.lang}/${mod.module}.md`, content };
}

function renderIndex(mods: SharedModuleDoc[]): GeneratedFile {
  const sections = LANG_ORDER.flatMap((lang) => {
    const inLang = mods.filter((mod) => mod.lang === lang);
    if (inLang.length === 0) return [];
    const items = inLang.map(
      (mod) =>
        `- [${lang}/${mod.module}](${lang}/${mod.module}.md) (${mod.symbols.map((s) => s.name).join(', ')})`,
    );
    return [`## ${lang}`, '', ...items, ''];
  });
  const content = [
    '# Shared modules',
    '',
    '<!-- Generated by `tbx gen` from source doc comments. Do not edit. -->',
    '',
    'Every tool reuses these modules. Check here before writing a helper.',
    '',
    ...sections,
  ].join('\n');
  return { path: 'docs/shared/index.md', content };
}

/** Renders `docs/shared/index.md` and one `docs/shared/<lang>/<module>.md` page per module. */
export function renderSharedDocs(mods: SharedModuleDoc[]): GeneratedFile[] {
  return [renderIndex(mods), ...mods.map((mod) => renderModulePage(mod))];
}

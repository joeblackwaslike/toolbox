import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { type GeneratedFile, compareText } from '../../shared/ts/src/gen/files.ts';
import { syncGenerated } from '../../shared/ts/src/gen/index.ts';
import { NAME_PATTERN } from '../../shared/ts/src/manifest.ts';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../templates');
const SUFFIX = '.tmpl';

/** Languages a tool or shared module can be scaffolded in. */
export const LANGS = ['ts', 'py', 'sh'] as const;
/** One of `LANGS`. */
export type Lang = (typeof LANGS)[number];

/** Placeholders a template may use in its paths and content. */
export interface TemplateVariables {
  /** `{{name}}`: the name as given, lowercase with dashes. */
  name: string;
  /** `{{ident}}`: the name in snake_case, for Python modules and shell functions. */
  ident: string;
  /** `{{camel}}`: the name in camelCase, for TypeScript identifiers. */
  camel: string;
}

/**
 * Checks `name` against the manifest name pattern and derives its template variables.
 *
 * @throws {ToolError} with exit code 2 when the name is invalid.
 */
export function templateVariables(name: string, what: string): TemplateVariables {
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      `invalid ${what} "${name}": use a lowercase letter, then up to 15 lowercase letters, digits or dashes`,
      ExitCode.usage,
    );
  }
  return {
    name,
    ident: name.replaceAll('-', '_'),
    camel: name.replaceAll(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()),
  };
}

function fill(text: string, variables: TemplateVariables): string {
  return text
    .replaceAll('{{name}}', variables.name)
    .replaceAll('{{ident}}', variables.ident)
    .replaceAll('{{camel}}', variables.camel);
}

/**
 * Renders every `*.tmpl` file under `tbx/templates/<set>` with `variables` filled into its path
 * and content. Paths are relative to the set, without the `.tmpl` suffix, sorted.
 */
export async function renderTemplates(
  set: string,
  variables: TemplateVariables,
): Promise<GeneratedFile[]> {
  const dir = path.join(TEMPLATES, set);
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: GeneratedFile[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(SUFFIX))) {
    const source = path.join(entry.parentPath, entry.name);
    files.push({
      path: fill(path.relative(dir, source).slice(0, -SUFFIX.length), variables),
      content: fill(await readFile(source, 'utf8'), variables),
    });
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

/** True when `file` exists. */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const EXECUTABLE = 0o755;

async function rollBack(created: readonly string[]): Promise<void> {
  for (const target of [...created].reverse()) await rm(target, { recursive: true, force: true });
}

async function writeTracked(
  root: string,
  files: GeneratedFile[],
  created: string[],
): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.path);
    const madeDir = await mkdir(path.dirname(target), { recursive: true });
    if (madeDir !== undefined) created.push(madeDir);
    await writeFile(target, file.content, { flag: 'wx' });
    created.push(target);
  }
}

/**
 * Writes new `files` under `root`, marks `executables` (paths relative to `root`) as
 * executable, then regenerates READMEs, completions and docs with `syncGenerated`. Nothing is
 * written when any of the files already exists. If a later step throws, every file and
 * directory this call created is removed before the error is rethrown, so a rerun starts
 * clean. Returns the written paths.
 *
 * @throws {ToolError} with exit code 2 naming the first file that already exists.
 */
export async function scaffold(
  root: string,
  files: GeneratedFile[],
  executables: readonly string[] = [],
): Promise<string[]> {
  for (const file of files) {
    if (await pathExists(path.join(root, file.path))) {
      throw new ToolError(`${file.path} already exists`, ExitCode.usage);
    }
  }
  const created: string[] = [];
  try {
    await writeTracked(root, files, created);
    for (const file of executables) await chmod(path.join(root, file), EXECUTABLE);
    await syncGenerated(root);
  } catch (error) {
    await rollBack(created);
    throw error;
  }
  return files.map((file) => file.path);
}

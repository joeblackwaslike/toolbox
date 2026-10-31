import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { type GeneratedFile, compareText } from '../../shared/ts/src/gen/files.ts';
import { writeGenerated } from '../../shared/ts/src/gen/index.ts';
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

/**
 * Writes `files` under `root`, but only when none of them exists yet.
 *
 * @throws {ToolError} with exit code 2 naming the first file that already exists.
 */
export async function writeNewFiles(root: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    if (await pathExists(path.join(root, file.path))) {
      throw new ToolError(`${file.path} already exists`, ExitCode.usage);
    }
  }
  await writeGenerated(root, files);
}

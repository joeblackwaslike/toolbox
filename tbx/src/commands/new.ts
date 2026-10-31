import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import { loadToolManifests, syncGenerated } from '../../../shared/ts/src/gen/index.ts';
import {
  ManifestError,
  type ToolManifest,
  assertNoCollisions,
  parseManifest,
} from '../../../shared/ts/src/manifest.ts';
import { binariesOnPath } from '../../../shared/ts/src/paths.ts';
import type { TbxContext } from '../context.ts';
import {
  type Lang,
  pathExists,
  renderTemplates,
  templateVariables,
  writeNewFiles,
} from '../templates.ts';

const INITIAL_VERSION = '0.1.0';
const EXECUTABLE = 0o755;

function asUsageError(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof ManifestError) throw new ToolError(error.message, ExitCode.usage);
    throw error;
  }
}

function manifestToml(name: string, lang: Lang, summary: string): string {
  const toml = `${stringify({
    name,
    summary,
    language: lang,
    version: INITIAL_VERSION,
    platforms: ['macos', 'linux'],
  })}\n`;
  asUsageError(() => parseManifest(toml));
  return toml;
}

/**
 * Scaffolds `tools/<name>/` from `tbx/templates/<lang>`: `tool.toml`, a `src/` entry wired to
 * the shared parser and helpers, one failing unit test as the TDD starting point and an
 * empty `tests/e2e/`, then regenerates READMEs, completions and docs. Exits 2 for an invalid
 * name or summary, an existing directory, or a name that collides with another tool's name
 * or alias or with a PATH binary.
 */
export async function newTool(
  ctx: TbxContext,
  name: string,
  options: { lang: Lang; summary?: string },
): Promise<void> {
  const variables = templateVariables(name, 'tool name');
  const toml = manifestToml(name, options.lang, options.summary ?? `TODO: describe ${name}`);
  const dir = `tools/${name}`;
  if (await pathExists(path.join(ctx.root, dir))) {
    throw new ToolError(`${dir} already exists`, ExitCode.usage);
  }
  const manifest: ToolManifest = parseManifest(toml);
  const existing = await loadToolManifests(ctx.root);
  const binaries = await binariesOnPath(ctx.path);
  asUsageError(() => {
    assertNoCollisions([...existing, manifest], binaries);
  });
  const rendered = await renderTemplates(options.lang, variables);
  const files = [{ path: 'tool.toml', content: toml }, ...rendered].map((file) => ({
    ...file,
    path: `${dir}/${file.path}`,
  }));
  await writeNewFiles(ctx.root, files);
  if (options.lang === 'sh') await chmod(path.join(ctx.root, dir, 'src', name), EXECUTABLE);
  await syncGenerated(ctx.root);
  const paths = files.map((file) => file.path);
  ctx.out.result(ctx.json ? { name, dir, files: paths } : `created ${dir}\n${paths.join('\n')}`);
}

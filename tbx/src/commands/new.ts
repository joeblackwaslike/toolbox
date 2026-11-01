import path from 'node:path';
import { stringify } from 'smol-toml';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import {
  ManifestError,
  type ToolManifest,
  assertNoCollisions,
  describePathCollision,
  findPathCollisions,
  parseManifest,
} from '../../../shared/ts/src/manifest.ts';
import type { TbxContext } from '../context.ts';
import {
  type Lang,
  pathExists,
  renderTemplates,
  scaffold,
  templateVariables,
} from '../templates.ts';

const INITIAL_VERSION = '0.1.0';

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

async function assertNameFree(ctx: TbxContext, manifest: ToolManifest): Promise<void> {
  for (const existing of await loadToolManifests(ctx.root)) {
    asUsageError(() => {
      assertNoCollisions([existing, manifest], []);
    });
  }
  const [collision] = findPathCollisions([manifest], await ctx.pathBinaries());
  if (collision !== undefined) {
    throw new ToolError(describePathCollision(collision), ExitCode.usage);
  }
}

/**
 * Scaffolds `tools/<name>/` from `tbx/templates/<lang>`: `tool.toml`, a `src/` entry wired to
 * the shared parser and helpers, one failing unit test as the TDD starting point and an
 * empty `tests/e2e/`, then regenerates READMEs, completions and docs. Exits 2 for an invalid
 * name or summary, an existing directory, or a name that collides with an existing tool's
 * name or alias or with a PATH executable. Only the new tool is checked, so an existing
 * collision between other tools does not block it. A failure after writing removes the tree.
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
  await assertNameFree(ctx, parseManifest(toml));
  const rendered = await renderTemplates(options.lang, variables);
  const files = [{ path: 'tool.toml', content: toml }, ...rendered].map((file) => ({
    ...file,
    path: `${dir}/${file.path}`,
  }));
  const executables = options.lang === 'sh' ? [`${dir}/src/${name}`] : [];
  const paths = await scaffold(ctx.root, files, executables);
  ctx.out.result(ctx.json ? { name, dir, files: paths } : `created ${dir}\n${paths.join('\n')}`);
}

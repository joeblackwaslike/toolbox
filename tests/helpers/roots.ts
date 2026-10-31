import { cp, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The repo checkout these tests run from. */
export const REPO = join(import.meta.dirname, '../..');

const CONFIGS = [
  'package.json',
  'biome.json',
  'eslint.config.mjs',
  'tsconfig.json',
  'pyproject.toml',
  '.editorconfig',
  'uv.lock',
  'vitest.config.ts',
  'justfile',
];

/** A temp root holding only the fixture tools under `tools/`. */
export async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tbx-cmd-'));
  await cp(join(REPO, 'tests/fixtures/tools'), join(root, 'tools'), { recursive: true });
  return root;
}

/**
 * A temp root with the fixture tools, a copy of `shared/`, the lint configs and a link to the
 * repo's `node_modules`, so scaffolded files can be run and linted outside the checkout.
 */
export async function scaffoldRoot(): Promise<string> {
  const root = await fixtureRoot();
  await cp(join(REPO, 'shared'), join(root, 'shared'), {
    recursive: true,
    filter: (source) => !/__pycache__|\.egg-info/.test(source),
  });
  for (const file of CONFIGS) {
    await cp(join(REPO, file), join(root, file));
  }
  await symlink(join(REPO, 'node_modules'), join(root, 'node_modules'));
  return root;
}

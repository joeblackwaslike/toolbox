import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeStamp, stampAll } from '../../tbx/src/commands/stamp.ts';
import { runTbx } from '../../tbx/src/index.ts';

async function put(root: string, file: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

function manifest(name: string): string {
  return [
    `name = "${name}"`,
    'summary = "Fixture tool"',
    'language = "ts"',
    'version = "0.1.0"',
    'platforms = ["macos", "linux"]',
  ].join('\n');
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tbx-stamp-'));
  await put(root, 'shared/ts/src/a.ts', 'export const A = 1;\n');
  await put(root, 'shared/ts/src/b.ts', 'export const B = 1;\n');
  await put(root, 'shared/ts/src/unused.ts', 'export const U = 1;\n');
  for (const [name, dep] of [
    ['alpha', 'a'],
    ['beta', 'b'],
  ] as const) {
    await put(root, `tools/${name}/tool.toml`, manifest(name));
    await put(
      root,
      `tools/${name}/src/index.ts`,
      `import { ${dep.toUpperCase()} } from '../../../shared/ts/src/${dep}.ts';\nconsole.log(${dep.toUpperCase()});\n`,
    );
  }
  await put(root, 'tbx/src/index.ts', "console.log('tbx');\n");
  return root;
}

describe('tbx stamp', () => {
  it('is stable across runs', async () => {
    const root = await fixture();
    expect(await computeStamp(root, 'alpha')).toBe(await computeStamp(root, 'alpha'));
  });

  it('changes only for tools that bundle the edited shared file', async () => {
    const root = await fixture();
    const [alpha, beta, tbx] = await Promise.all(
      ['alpha', 'beta', 'tbx-cli'].map((c) => computeStamp(root, c)),
    );
    await put(root, 'shared/ts/src/a.ts', 'export const A = 2;\n');
    expect(await computeStamp(root, 'alpha')).not.toBe(alpha);
    expect(await computeStamp(root, 'beta')).toBe(beta);
    expect(await computeStamp(root, 'tbx-cli')).toBe(tbx);
    await put(root, 'shared/ts/src/unused.ts', 'export const U = 2;\n');
    expect(await computeStamp(root, 'beta')).toBe(beta);
  });

  it('changes every stamp when the generator version changes', async () => {
    const root = await fixture();
    for (const c of ['alpha', 'beta', 'tbx-cli']) {
      expect(await computeStamp(root, c, 'other')).not.toBe(await computeStamp(root, c));
    }
  });

  it('writes stamps for every tool and tbx, then reports nothing changed', async () => {
    const root = await fixture();
    const first = await stampAll(root, true);
    expect(first.map((r) => r.component)).toEqual(['alpha', 'beta', 'tbx-cli']);
    expect(first.every((r) => r.changed)).toBe(true);
    expect(await readFile(join(root, 'tbx/.shared-stamp'), 'utf8')).toBe(
      `${await computeStamp(root, 'tbx-cli')}\n`,
    );
    expect((await stampAll(root, true)).some((r) => r.changed)).toBe(false);
  });

  it('--check exits non-zero on a stale stamp and zero when current', async () => {
    const root = await fixture();
    expect((await runTbx(['stamp', '--check'], { root })).code).not.toBe(0);
    const written = await runTbx(['stamp', '--write'], { root });
    expect(written.stdout.trim().split('\n')).toEqual(['alpha', 'beta', 'tbx-cli']);
    expect((await runTbx(['stamp', '--check'], { root })).code).toBe(0);
    await put(root, 'shared/ts/src/b.ts', 'export const B = 2;\n');
    const stale = await runTbx(['stamp', '--check'], { root });
    expect(stale.code).not.toBe(0);
    expect(stale.stdout.trim()).toBe('beta');
  });
});

describe('tbx stamp on the real repo', () => {
  it('stamps tbx-cli without throwing and stably', async () => {
    const root = join(import.meta.dirname, '../..');
    const first = await computeStamp(root, 'tbx-cli');
    expect(await computeStamp(root, 'tbx-cli')).toBe(first);
    const results = await stampAll(root, false);
    expect(results.map((r) => r.component)).toContain('tbx-cli');
  });
});

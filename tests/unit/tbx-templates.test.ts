import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkDrift } from '../../shared/ts/src/gen/index.ts';
import { loadManifest } from '../../shared/ts/src/manifest.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { REPO, scaffoldRoot } from '../helpers/roots.ts';

const BIN = join(REPO, 'node_modules/.bin');

function exec(
  root: string,
  command: string,
  args: string[],
): { status: number | null; out: string } {
  const run = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return { status: run.status, out: stripVTControlCharacters(`${run.stdout}${run.stderr}`) };
}

function uv(root: string, args: string[]): { status: number | null; out: string } {
  return exec(root, 'uv', ['run', '--project', REPO, ...args]);
}

describe('tool templates', () => {
  let root: string;

  beforeAll(async () => {
    root = await scaffoldRoot();
    for (const [name, lang] of [
      ['t-ts', 'ts'],
      ['t-py', 'py'],
      ['t-sh', 'sh'],
    ] as const) {
      expect((await runTbx(['new', name, '--lang', lang, '-y'], { root, path: '' })).code).toBe(0);
    }
  });

  it('every scaffolded tool.toml loads and names its language', async () => {
    for (const lang of ['ts', 'py', 'sh']) {
      const manifest = await loadManifest(join(root, `tools/t-${lang}/tool.toml`));
      expect(manifest).toMatchObject({ name: `t-${lang}`, language: lang, version: '0.1.0' });
    }
  });

  it('each entry runs through the shared parser and prints its name', () => {
    expect(exec(root, 'bun', ['tools/t-ts/src/index.ts', '--json']).out).toBe('"t-ts"\n');
    expect(uv(root, ['python', 'tools/t-py/src/t_py.py', '--json']).out).toBe('"t-py"\n');
    expect(exec(root, 'bash', ['tools/t-sh/src/t-sh', '--json']).out).toBe('"t-sh"\n');
    expect(exec(root, 'bash', ['tools/t-sh/src/t-sh', '--bogus']).status).toBe(2);
  });

  it('the ts template passes biome, eslint and tsc', () => {
    expect(exec(root, join(BIN, 'eslint'), ['--max-warnings=0', 'tools/t-ts'])).toEqual({
      status: 0,
      out: '',
    });
    expect(exec(root, join(BIN, 'biome'), ['ci', '--colors=off', 'tools/t-ts'])).toMatchObject({
      status: 0,
    });
    expect(exec(root, join(BIN, 'tsc'), ['--noEmit', '-p', 'tsconfig.json'])).toEqual({
      status: 0,
      out: '',
    });
  });

  it('the py template passes ruff check and ruff format', () => {
    expect(uv(root, ['ruff', 'check', 'tools/t-py'])).toMatchObject({ status: 0 });
    expect(uv(root, ['ruff', 'format', '--check', 'tools/t-py'])).toMatchObject({ status: 0 });
  });

  it('the sh template passes shellcheck and shfmt', () => {
    expect(exec(root, 'shellcheck', ['tools/t-sh/src/t-sh'])).toEqual({ status: 0, out: '' });
    expect(exec(root, 'shfmt', ['-d', 'tools/t-sh/src/t-sh'])).toEqual({ status: 0, out: '' });
  });

  it('each scaffolded unit test fails on its placeholder expectation', () => {
    const vitest = exec(root, join(BIN, 'vitest'), ['run', '--root', root, 'tools/t-ts']);
    expect(vitest.status).toBe(1);
    expect(vitest.out).toContain(
      "expected [ 't-ts' ] to deeply equal [ 'replace with what t-ts prints' ]",
    );
    const pytest = uv(root, ['pytest', '-p', 'no:faulthandler', '-q', 'tools/t-py']);
    expect(pytest.status).toBe(1);
    expect(pytest.out).toContain("AssertionError: assert 't-py' == 'replace with");
  });
});

describe('shared module templates', () => {
  let root: string;

  beforeAll(async () => {
    root = await scaffoldRoot();
    for (const lang of ['ts', 'py', 'sh']) {
      const result = await runTbx(['shared', 'new', 'zz-stub', '--lang', lang, '-y'], {
        root,
        path: '',
      });
      expect(result.code).toBe(0);
    }
  });

  it('the ts module passes biome, eslint and tsc and its test fails on the stub', () => {
    const files = ['shared/ts/src/zz-stub.ts', 'tests/unit/zz-stub.test.ts'];
    expect(exec(root, join(BIN, 'biome'), ['ci', '--colors=off', ...files])).toMatchObject({
      status: 0,
    });
    expect(exec(root, join(BIN, 'eslint'), ['--max-warnings=0', files[0] ?? ''])).toEqual({
      status: 0,
      out: '',
    });
    expect(exec(root, join(BIN, 'tsc'), ['--noEmit', '-p', 'tsconfig.json'])).toEqual({
      status: 0,
      out: '',
    });
    const vitest = exec(root, join(BIN, 'vitest'), ['run', '--root', root, 'tests/unit/zz-stub']);
    expect(vitest.status).toBe(1);
    expect(vitest.out).toContain('Error: zzStub is not implemented');
  });

  it('the py module passes ruff and mypy', () => {
    const files = ['shared/py/tbx_shared/zz_stub.py', 'shared/py/tests/test_zz_stub.py'];
    expect(uv(root, ['ruff', 'check', ...files])).toMatchObject({ status: 0 });
    expect(uv(root, ['ruff', 'format', '--check', ...files])).toMatchObject({ status: 0 });
    expect(uv(root, ['mypy', files[0] ?? ''])).toMatchObject({ status: 0 });
  });

  it('the sh module passes shellcheck and shfmt and its bats test fails on the stub', () => {
    expect(exec(root, 'shellcheck', ['shared/sh/zz-stub.sh'])).toEqual({ status: 0, out: '' });
    expect(exec(root, 'shfmt', ['-d', 'shared/sh/zz-stub.sh'])).toEqual({ status: 0, out: '' });
    const bats = exec(root, 'bats', ['tests/unit/zz-stub.bats']);
    expect(bats.status).toBe(1);
    expect(bats.out).toContain('not ok 1 tbx_zz_stub prints its result');
    expect(bats.out).toContain('[ "$status" -eq 0 ]');
  });

  it('the generated shared docs list every stub with its doc', async () => {
    expect(await checkDrift(root)).toEqual([]);
    for (const page of ['ts/zz-stub.md', 'py/zz_stub.md', 'sh/zz-stub.md']) {
      expect(await readFile(join(root, 'docs/shared', page), 'utf8')).toContain('Stub: say what');
    }
  });
});

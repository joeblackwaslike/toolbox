import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { checkDrift } from '../../shared/ts/src/gen/index.ts';
import { loadManifest } from '../../shared/ts/src/manifest.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { REPO, fixtureRoot, scaffoldRoot } from '../helpers/roots.ts';

const NO_PATH = { path: '' };

type SharedHitJson = Record<string, string>;

async function missing(file: string): Promise<boolean> {
  return access(file).then(
    () => false,
    () => true,
  );
}

describe('tbx list', () => {
  it('list --json returns every tool manifest name', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['list', '--json'], { root, ...NO_PATH });
    expect(result.code).toBe(0);
    const tools = JSON.parse(result.stdout) as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(['demo']);
  });

  it('list prints a table with name, version, language, platforms and summary', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['list'], { root, ...NO_PATH });
    expect(result.code).toBe(0);
    const [header, row] = result.stdout.trimEnd().split('\n');
    expect(header?.split(/\s+/)).toEqual(['name', 'version', 'language', 'platforms', 'summary']);
    expect(row).toMatch(/^demo\s+0\.1\.0\s+ts\s+macos,linux\s+Demo tool for parser/);
  });
});

describe('tbx help', () => {
  it('help <tool> --json prints the manifest-derived usage', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['help', 'demo', '--json'], { root, ...NO_PATH });
    expect(result.code).toBe(0);
    const manifest = await loadManifest(join(root, 'tools/demo/tool.toml'));
    expect(JSON.parse(result.stdout)).toEqual(usageOf(manifest));
  });

  it('help with an unknown tool exits 2 and lists close matches', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['help', 'dmeo', '--json'], { root, ...NO_PATH });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown tool "dmeo"');
    expect(result.stderr).toContain('demo');
  });
});

async function pathWith(...binaries: string[]): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tbx-bin-'));
  for (const binary of binaries) await writeFile(join(dir, binary), '');
  return { path: dir };
}

describe('tbx gen', () => {
  it('gen writes every generated file and gen --check then passes', async () => {
    const root = await fixtureRoot();
    expect((await runTbx(['gen'], { root, ...NO_PATH })).code).toBe(0);
    expect(await readFile(join(root, 'tools/demo/README.md'), 'utf8')).toContain('# demo');
    const check = await runTbx(['gen', '--check', '--json'], { root, ...NO_PATH });
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual([]);
  });

  it('gen --check exits 1 and names drifted files', async () => {
    const root = await fixtureRoot();
    await runTbx(['gen'], { root, ...NO_PATH });
    await writeFile(join(root, 'tools/demo/README.md'), 'hand edit\n');
    const result = await runTbx(['gen', '--check'], { root, ...NO_PATH });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('tools/demo/README.md');
    const json = await runTbx(['gen', '--check', '--json'], { root, ...NO_PATH });
    expect(JSON.parse(json.stdout)).toEqual(['tools/demo/README.md']);
  });

  it('gen refuses a tool whose alias shadows a PATH binary', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['gen'], { root, ...(await pathWith('dm')) });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('"dm" collides');
    await expect(readFile(join(root, 'tools/demo/README.md'))).rejects.toThrow();
    expect((await runTbx(['gen', '--check'], { root, ...(await pathWith('dm')) })).code).toBe(78);
  });

  it('gen refuses two tools that share a name or alias', async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, 'tools/other'));
    const demo = await readFile(join(root, 'tools/demo/tool.toml'), 'utf8');
    await writeFile(
      join(root, 'tools/other/tool.toml'),
      demo.replace('name = "demo"', 'name = "other"'),
    );
    const result = await runTbx(['gen'], { root, ...NO_PATH });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('"dm" collides');
  });
});

describe('tbx new', () => {
  it('new refuses a colliding name', async () => {
    const root = await fixtureRoot();
    const alias = await runTbx(['new', 'dm', '--lang', 'sh', '-y'], { root, ...NO_PATH });
    expect(alias.code).toBe(2);
    expect(alias.stderr).toContain('"dm" collides');
    expect(await missing(join(root, 'tools/dm'))).toBe(true);
    const binary = await runTbx(['new', 'git', '--lang', 'ts', '-y'], {
      root,
      ...(await pathWith('git')),
    });
    expect(binary.code).toBe(2);
    expect(binary.stderr).toContain('"git" collides: name of tool "git" and PATH binary');
    expect(await missing(join(root, 'tools/git'))).toBe(true);
  });

  it('new refuses an existing directory and an invalid name', async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, 'tools/taken'));
    const taken = await runTbx(['new', 'taken', '--lang', 'py', '-y'], { root, ...NO_PATH });
    expect(taken.code).toBe(2);
    expect(taken.stderr).toContain('tools/taken already exists');
    const bad = await runTbx(['new', 'Bad_Name', '--lang', 'py', '-y'], { root, ...NO_PATH });
    expect(bad.code).toBe(2);
    expect(await missing(join(root, 'tools/Bad_Name'))).toBe(true);
    const lang = await runTbx(['new', 'fine', '--lang', 'rb', '-y'], { root, ...NO_PATH });
    expect(lang.code).toBe(2);
  });

  it('new --lang sh creates a manifest and a failing bats test', async () => {
    const root = await scaffoldRoot();
    const result = await runTbx(['new', 'hello', '--lang', 'sh', '-y', '--json'], {
      root,
      ...NO_PATH,
    });
    expect(result.code).toBe(0);
    const manifest = await loadManifest(join(root, 'tools/hello/tool.toml'));
    expect(manifest).toMatchObject({ name: 'hello', language: 'sh', version: '0.1.0' });
    expect(await readFile(join(root, 'tools/hello/README.md'), 'utf8')).toContain('# hello');
    expect(await missing(join(root, 'tools/hello/tests/e2e/.gitkeep'))).toBe(false);
    const entry = spawnSync('bash', [join(root, 'tools/hello/src/hello'), '--json'], {
      encoding: 'utf8',
    });
    expect(entry.stdout).toBe('"hello"\n');
    const bats = spawnSync('bats', [join(root, 'tools/hello/tests/unit/hello.bats')], {
      encoding: 'utf8',
    });
    expect(bats.status).toBe(1);
    expect(bats.stdout).toContain('not ok 1 hello prints its result as JSON');
    expect(bats.stdout).toContain(`'"replace with what hello prints"'`);
  });
});

describe('tbx shared search', () => {
  it('shared search finds a helper by a word in its doc comment', async () => {
    const result = await runTbx(['shared', 'search', 'MACHINE-readable', '--json'], {
      root: REPO,
      ...NO_PATH,
    });
    expect(result.code).toBe(0);
    const hits = JSON.parse(result.stdout) as SharedHitJson[];
    expect(hits).toContainEqual({
      lang: 'ts',
      module: 'output',
      symbol: 'Output',
      signature: 'interface Output',
      summary:
        "Output channel for a tool. `result` is the program's answer and goes to stdout; `info` and",
    });
    const retry = await runTbx(['shared', 'search', 'retry', '--json'], { root: REPO, ...NO_PATH });
    const symbols = (JSON.parse(retry.stdout) as SharedHitJson[]).map(
      (hit) => `${hit.lang}/${hit.symbol}`,
    );
    expect(symbols).toEqual(['py/retry_policy', 'py/with_retry']);
  });

  it('shared search matches a symbol name and prints one line per hit', async () => {
    const result = await runTbx(['shared', 'search', 'binariesonpath'], { root: REPO, ...NO_PATH });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ts/paths.binariesOnPath');
    expect(result.stdout).toContain('function binariesOnPath(');
    const none = await runTbx(['shared', 'search', 'zzz-no-such-word', '--json'], {
      root: REPO,
      ...NO_PATH,
    });
    expect(JSON.parse(none.stdout)).toEqual([]);
  });
});

describe('tbx shared new', () => {
  it('shared new --lang py creates a module, a failing test and a doc stub', async () => {
    const root = await scaffoldRoot();
    const result = await runTbx(['shared', 'new', 'my-helper', '--lang', 'py', '-y'], {
      root,
      ...NO_PATH,
    });
    expect(result.code).toBe(0);
    const module = await readFile(join(root, 'shared/py/tbx_shared/my_helper.py'), 'utf8');
    expect(module).toContain('def my_helper() -> str:');
    expect(await readFile(join(root, 'docs/shared/py/my_helper.md'), 'utf8')).toContain(
      '## my_helper',
    );
    expect(await checkDrift(root)).toEqual([]);
    const pytest = spawnSync(
      'env',
      [
        `PYTHONPATH=${join(root, 'shared/py')}`,
        'uv',
        ...['run', '--project', REPO, 'pytest', '-p', 'no:faulthandler', '-q'],
        'shared/py/tests/test_my_helper.py',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(pytest.status).toBe(1);
    expect(pytest.stdout).toContain('NotImplementedError: my_helper is not implemented');
  });

  it('shared new refuses an existing module', async () => {
    const root = await scaffoldRoot();
    const before = await readFile(join(root, 'shared/ts/src/output.ts'), 'utf8');
    const result = await runTbx(['shared', 'new', 'output', '--lang', 'ts', '-y'], {
      root,
      ...NO_PATH,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('shared/ts/src/output.ts already exists');
    expect(await readFile(join(root, 'shared/ts/src/output.ts'), 'utf8')).toBe(before);
    expect(await missing(join(root, 'tests/unit/output.test.ts'))).toBe(true);
    const bad = await runTbx(['shared', 'new', '9lives', '--lang', 'sh', '-y'], {
      root,
      ...NO_PATH,
    });
    expect(bad.code).toBe(2);
  });
});

describe('tbx flags', () => {
  it('an unknown flag exits 2 with nothing on stdout', async () => {
    const result = await runTbx(['list', '--bogus'], { root: REPO, ...NO_PATH });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--bogus'");
  });

  it('--help exits 0 and prints the command list', async () => {
    const result = await runTbx(['--help'], { root: REPO, ...NO_PATH });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list');
  });
});

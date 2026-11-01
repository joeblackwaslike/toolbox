import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { checkDrift } from '../../shared/ts/src/gen/index.ts';
import { RESERVED_COMMANDS, loadManifest } from '../../shared/ts/src/manifest.ts';
import { isEntryPoint, runTbx } from '../../tbx/src/index.ts';
import { REPO, fixtureRoot, scaffoldRoot } from '../helpers/roots.ts';

const NO_PATH = { path: '', vars: { HOME: mkdtempSync(join(tmpdir(), 'tbx-home-')) } };
const EXECUTABLE = 0o755;

type SharedHitJson = Record<string, string>;

async function missing(file: string): Promise<boolean> {
  return access(file).then(
    () => false,
    () => true,
  );
}

async function homeWithState(state: string): Promise<Record<string, string>> {
  const home = await mkdtemp(join(tmpdir(), 'tbx-home-'));
  await mkdir(join(home, '.local/state/tbx'), { recursive: true });
  await writeFile(join(home, '.local/state/tbx/installed.json'), state);
  return { HOME: home };
}

describe('tbx list', () => {
  it('list reads the install record from the given HOME, never the real one', async () => {
    const root = await fixtureRoot();
    const vars = await homeWithState(
      JSON.stringify({
        tools: { demo: { version: '9.9.9', installedAt: '2026-10-31T00:00:00Z' } },
      }),
    );
    const result = await runTbx(['list', '--json'], { root, path: '', vars });
    expect(result.code).toBe(0);
    const tools = JSON.parse(result.stdout) as { name: string; installed: string | null }[];
    expect(tools.map((tool) => [tool.name, tool.installed])).toEqual([['demo', '9.9.9']]);
  });

  it('list exits 78 with a clear message for a corrupt install record', async () => {
    const root = await fixtureRoot();
    const vars = await homeWithState('{ not json');
    const result = await runTbx(['list'], { root, path: '', vars });
    expect(result).toMatchObject({ code: 78, stdout: '' });
    expect(result.stderr).toMatch(/^error: .*installed\.json is not a valid install record/);
  });

  it('list --json returns every tool manifest name', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['list', '--json'], { root, ...NO_PATH });
    expect(result.code).toBe(0);
    const tools = JSON.parse(result.stdout) as { name: string; installed: string | null }[];
    expect(tools.map((tool) => [tool.name, tool.installed])).toEqual([['demo', null]]);
  });

  it('list prints a table with name, version, installed, language, platforms and summary', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['list'], { root, ...NO_PATH });
    expect(result.code).toBe(0);
    const [header, row] = result.stdout.trimEnd().split('\n');
    expect(header?.split(/\s+/)).toEqual([
      'name',
      'version',
      'installed',
      'language',
      'platforms',
      'summary',
    ]);
    expect(row).toMatch(/^demo\s+0\.1\.0\s+-\s+ts\s+macos,linux\s+Demo tool for parser/);
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

async function executablesIn(dir: string, ...binaries: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const binary of binaries) {
    await writeFile(join(dir, binary), '#!/bin/sh\n');
    await chmod(join(dir, binary), EXECUTABLE);
  }
}

async function pathWith(
  ...binaries: string[]
): Promise<{ path: string; vars: Record<string, string> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tbx-bin-')));
  await executablesIn(dir, ...binaries);
  return { path: dir, vars: {} };
}

async function addTool(root: string, name: string, alias: string): Promise<void> {
  const demo = await readFile(join(root, 'tools/demo/tool.toml'), 'utf8');
  await mkdir(join(root, 'tools', name));
  await writeFile(
    join(root, 'tools', name, 'tool.toml'),
    demo.replace('name = "demo"', `name = "${name}"`).replace('alias = "dm"', `alias = "${alias}"`),
  );
}

const BROKEN_PY = 'shared/py/tbx_shared/broken.py';

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

  it('gen warns about a PATH collision by default and still writes', async () => {
    const root = await fixtureRoot();
    const env = await pathWith('dm');
    const result = await runTbx(['gen'], { root, ...env });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      `warning: "dm" collides: alias of tool "demo" and PATH binary ${join(env.path, 'dm')}`,
    );
    expect(await readFile(join(root, 'tools/demo/README.md'), 'utf8')).toContain('# demo');
    expect((await runTbx(['gen', '--check'], { root, ...env })).code).toBe(0);
  });

  it('gen --strict and CI=1 refuse a PATH collision with exit 78', async () => {
    const root = await fixtureRoot();
    const env = await pathWith('dm');
    const strict = await runTbx(['gen', '--strict'], { root, ...env });
    expect(strict.code).toBe(78);
    expect(strict.stderr).toContain('"dm" collides');
    await expect(readFile(join(root, 'tools/demo/README.md'))).rejects.toThrow();
    expect((await runTbx(['gen', '--check'], { root, ...env, vars: { CI: '1' } })).code).toBe(78);
    expect((await runTbx(['gen'], { root, ...env, vars: { CI: '1' } })).code).toBe(78);
  });

  it('gen ignores PATH entries under the repo root and the tbx bin dir', async () => {
    const root = await fixtureRoot();
    const binDir = await realpath(await mkdtemp(join(tmpdir(), 'tbx-managed-')));
    await executablesIn(join(root, 'node_modules/.bin'), 'dm');
    await executablesIn(binDir, 'demo');
    const path = [join(root, 'node_modules/.bin'), binDir].join(delimiter);
    const result = await runTbx(['gen', '--strict'], { root, path, vars: { TBX_BIN_DIR: binDir } });
    expect(result).toMatchObject({ code: 0, stderr: '' });
  });

  it('gen refuses two tools that share a name or alias', async () => {
    const root = await fixtureRoot();
    await addTool(root, 'other', 'dm');
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

  it('new is not blocked by an unrelated existing collision', async () => {
    const root = await fixtureRoot();
    await addTool(root, 'other', 'dm');
    const result = await runTbx(['new', 'hello', '--lang', 'sh', '-y'], {
      root,
      ...(await pathWith('demo')),
    });
    expect(result.code).toBe(0);
    expect(await missing(join(root, 'tools/hello/tool.toml'))).toBe(false);
  });

  it('new removes everything it wrote when a later step fails, so a rerun succeeds', async () => {
    const root = await scaffoldRoot();
    await writeFile(join(root, BROKEN_PY), 'def (:\n');
    const failed = await runTbx(['new', 'hello', '--lang', 'py', '-y'], { root, ...NO_PATH });
    expect(failed).toMatchObject({ code: 1, stdout: '' });
    expect(failed.stderr).toMatch(/^error: .*SyntaxError/s);
    expect(await missing(join(root, 'tools/hello'))).toBe(true);
    await rm(join(root, BROKEN_PY));
    expect((await runTbx(['new', 'hello', '--lang', 'py', '-y'], { root, ...NO_PATH })).code).toBe(
      0,
    );
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

  it('new refuses a name that is a tbx subcommand', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['new', 'doctor', '--lang', 'sh', '-y'], { root, ...NO_PATH });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('tbx subcommand');
    expect(await missing(join(root, 'tools/doctor'))).toBe(true);
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

  it('shared new removes everything it wrote when a later step fails, so a rerun succeeds', async () => {
    const root = await scaffoldRoot();
    await writeFile(join(root, BROKEN_PY), 'def (:\n');
    const argv = ['shared', 'new', 'roll', '--lang', 'ts', '-y'];
    expect(await runTbx(argv, { root, ...NO_PATH })).toMatchObject({ code: 1, stdout: '' });
    expect(await missing(join(root, 'shared/ts/src/roll.ts'))).toBe(true);
    expect(await missing(join(root, 'tests'))).toBe(true);
    expect(await missing(join(root, 'shared/ts/src'))).toBe(false);
    await rm(join(root, BROKEN_PY));
    expect((await runTbx(argv, { root, ...NO_PATH })).code).toBe(0);
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

  it('an unexpected error exits 1 with an error line and no stack trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tbx-cmd-'));
    await writeFile(join(root, 'tools'), 'not a directory');
    const result = await runTbx(['list'], { root, ...NO_PATH });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: .*ENOTDIR/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('isEntryPoint compares the module path with the resolved argv[1]', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'tbx-main-')));
    const file = join(dir, 'main.ts');
    await writeFile(file, '');
    await symlink(file, join(dir, 'link.ts'));
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(url, file)).toBe(true);
    expect(isEntryPoint(url, join(dir, 'link.ts'))).toBe(true);
    expect(isEntryPoint(url, join(dir, 'other.ts'))).toBe(false);
    expect(isEntryPoint(url, undefined)).toBe(false);
  });

  it('every tbx subcommand is in RESERVED_COMMANDS', async () => {
    const result = await runTbx(['--help'], { root: REPO, ...NO_PATH });
    const commands = result.stdout
      .split('Commands:')[1]
      ?.split('\n')
      .map((line) => /^ {2}(\S+)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(commands?.length).toBeGreaterThan(5);
    for (const command of commands ?? []) expect(RESERVED_COMMANDS).toContain(command);
  });
});

describe('tbx build, install and uninstall', () => {
  it('build writes the artifact and index that install all and uninstall use', async () => {
    const root = await scaffoldRoot();
    expect((await runTbx(['new', 'c-sh', '--lang', 'sh', '-y'], { root, ...NO_PATH })).code).toBe(
      0,
    );
    const build = await runTbx(['build', 'c-sh', '--json'], { root, ...NO_PATH });
    expect(build).toMatchObject({ code: 0, stderr: '' });
    const built = JSON.parse(build.stdout) as { index: string; built: { name: string }[] };
    expect(built.index).toBe(join(root, 'dist/release/index.json'));
    expect(built.built.map((tool) => tool.name)).toEqual(['c-sh']);
    const vars = { HOME: await mkdtemp(join(tmpdir(), 'tbx-home-')) };
    const install = await runTbx(['install', 'all', '--json'], { root, path: '', vars });
    expect(install).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(install.stdout)).toEqual({ installed: [{ name: 'c-sh', version: '0.1.0' }] });
    const removed = await runTbx(['uninstall', 'c-sh', '--json'], { root, path: '', vars });
    expect(removed).toMatchObject({ code: 0, stdout: '{"uninstalled":"c-sh"}\n' });
  });

  it('build exits 1 with a message when a build step fails', async () => {
    const root = await fixtureRoot();
    const result = await runTbx(['build', 'demo', '--out', join(root, 'out')], {
      root,
      ...NO_PATH,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error: build of demo failed:');
    expect(await missing(join(root, 'out/index.json'))).toBe(true);
  });

  it('install exits 1 naming the index when the tool is not in it', async () => {
    const root = await scaffoldRoot();
    const index = join(root, 'index.json');
    await writeFile(index, '{"tools":[]}');
    const vars = { HOME: await mkdtemp(join(tmpdir(), 'tbx-home-')) };
    const result = await runTbx(['install', 'nope', '--index', index], { root, path: '', vars });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`nope is not in ${index}`);
  });

  it('install exits 1 pointing at tbx build when no index has been built', async () => {
    const root = await fixtureRoot();
    const vars = { HOME: await mkdtemp(join(tmpdir(), 'tbx-home-')) };
    const result = await runTbx(['install', 'demo'], { root, path: '', vars });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run `tbx build` first');
  });
});

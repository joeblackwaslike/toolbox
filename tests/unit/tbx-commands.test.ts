import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { loadManifest } from '../../shared/ts/src/manifest.ts';
import { runTbx } from '../../tbx/src/index.ts';

const REPO = join(import.meta.dirname, '../..');
const FIXTURES = join(REPO, 'tests/fixtures');
const NO_PATH = { path: '' };

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tbx-cmd-'));
  await cp(join(FIXTURES, 'tools'), join(root, 'tools'), { recursive: true });
  return root;
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

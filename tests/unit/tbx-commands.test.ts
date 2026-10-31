import { cp, mkdtemp } from 'node:fs/promises';
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

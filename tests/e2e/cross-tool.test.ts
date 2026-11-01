import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { loadManifest } from '../../shared/ts/src/manifest.ts';
import { readIndex } from '../../tbx/src/commands/build.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { CURRENT_PLATFORM } from '../../tbx/src/stage.ts';
import { REPO, realToolsRoot } from '../helpers/roots.ts';

const SCAFFOLDED = [
  ['x-ts', 'ts'],
  ['x-py', 'py'],
  ['x-sh', 'sh'],
] as const;

const SETUP_TIMEOUT_MS = 300_000;

interface Listed {
  name: string;
  version: string;
  platforms: string[];
  installed: string | null;
}

let root: string;
let index: string;
let home: string;
let vars: Record<string, string>;
let names: string[];
let supported: string[];
let installResult: { installed: { name: string; version: string }[]; skipped?: string[] };

function tbx(argv: string[]) {
  return runTbx(argv, { root, path: '', vars });
}

beforeAll(async () => {
  root = await realToolsRoot();
  for (const [name, lang] of SCAFFOLDED) {
    expect(await runTbx(['new', name, '--lang', lang], { root, path: '', vars: {} })).toMatchObject(
      { code: 0 },
    );
  }
  home = await mkdtemp(join(tmpdir(), 'tbx-all-home-'));
  vars = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    TBX_BIN_DIR: join(home, 'bin'),
  };
  const out = await mkdtemp(join(tmpdir(), 'tbx-all-rel-'));
  const built = await tbx(['build', 'all', '--out', out]);
  expect(built).toMatchObject({ code: 0 });
  index = join(out, 'index.json');
  names = (await readdir(join(root, 'tools'))).sort();
  const listed = JSON.parse((await tbx(['--json', 'list'])).stdout) as Listed[];
  supported = listed.filter((tool) => tool.platforms.includes(CURRENT_PLATFORM)).map((t) => t.name);
  const installed = await tbx(['--json', 'install', 'all', '--index', index]);
  expect(installed.code).toBe(0);
  installResult = JSON.parse(installed.stdout) as typeof installResult;
}, SETUP_TIMEOUT_MS);

describe('every tool in one root', () => {
  it('install all then tbx list shows every tool at its built version', async () => {
    const entries = await readIndex(index);
    expect(entries.map((entry) => entry.name)).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(['transcribe', ...SCAFFOLDED.map(([n]) => n)]));

    const listed = JSON.parse((await tbx(['--json', 'list'])).stdout) as Listed[];
    expect(listed.map((tool) => [tool.name, tool.version])).toEqual(
      entries.map((entry) => [entry.name, entry.version]),
    );

    const unsupported = names.filter((name) => !supported.includes(name));
    expect(installResult.installed.map((tool) => tool.name).sort()).toEqual(supported);
    expect(installResult.skipped ?? []).toEqual(unsupported);

    const state = JSON.parse(
      await readFile(join(vars.XDG_STATE_HOME ?? '', 'tbx/installed.json'), 'utf8'),
    ) as {
      tools: Record<string, { version: string }>;
    };
    for (const entry of entries.filter((e) => supported.includes(e.name))) {
      expect(state.tools[entry.name]?.version).toBe(entry.version);
      expect((await lstat(join(vars.TBX_BIN_DIR ?? '', entry.name))).isSymbolicLink()).toBe(true);
    }
    expect(Object.keys(state.tools).sort()).toEqual(supported);

    const after = JSON.parse((await tbx(['--json', 'list'])).stdout) as Listed[];
    expect(after.map((tool) => [tool.name, tool.installed])).toEqual(
      entries.map((entry) => [entry.name, supported.includes(entry.name) ? entry.version : null]),
    );
    const table = (await tbx(['list'])).stdout;
    for (const entry of entries) {
      const installed = supported.includes(entry.name) ? entry.version : '-';
      const version = (text: string): string => text.replaceAll('.', String.raw`\.`);
      expect(table).toMatch(
        new RegExp(String.raw`${entry.name}\s+${version(entry.version)}\s+${version(installed)}\s`),
      );
    }
  });

  it("tbx help <tool> --json matches that tool's tool.toml for every tool", async () => {
    for (const name of names) {
      const manifest = await loadManifest(join(root, 'tools', name, 'tool.toml'));
      const result = await tbx(['--json', 'help', name]);
      expect({ name, code: result.code }).toEqual({ name, code: 0 });
      expect({ name, usage: JSON.parse(result.stdout) as unknown }).toEqual({
        name,
        usage: JSON.parse(JSON.stringify(usageOf(manifest))) as unknown,
      });
    }
  });

  it('tbx <tool> dispatch runs an installed tool of every language and passes exit codes through', () => {
    const run = (args: string[]) =>
      spawnSync('bun', ['tbx/src/index.ts', ...args], { cwd: REPO, encoding: 'utf8', env: vars });
    for (const [name] of SCAFFOLDED) {
      const ok = run([name, '--json']);
      expect({ name, status: ok.status, stdout: JSON.parse(ok.stdout) as unknown }).toEqual({
        name,
        status: 0,
        stdout: name,
      });
      const direct = spawnSync(join(vars.TBX_BIN_DIR ?? '', name), ['--no-such-flag'], {
        encoding: 'utf8',
        env: vars,
      });
      const bad = run([name, '--no-such-flag']);
      expect({ name, status: bad.status }).toEqual({ name, status: direct.status });
      expect(bad.status).not.toBe(0);
    }
  });
});

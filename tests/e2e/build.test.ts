import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256, unpackTar } from '../../tbx/src/archive.ts';
import { type IndexEntry, buildTool, writeIndex } from '../../tbx/src/commands/build.ts';
import { installTool } from '../../tbx/src/commands/install.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { scaffoldRoot } from '../helpers/roots.ts';

const TOOLS = [
  ['b-ts', 'ts'],
  ['b-py', 'py'],
  ['b-sh', 'sh'],
] as const;

const BUILD_TIMEOUT_MS = 180_000;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let root: string;
let out: string;
const built = new Map<string, Awaited<ReturnType<typeof buildTool>>>();

beforeAll(async () => {
  root = await scaffoldRoot();
  out = await mkdtemp(join(tmpdir(), 'tbx-out-'));
  for (const [name, lang] of TOOLS) {
    const result = await runTbx(['new', name, '--lang', lang], { root, path: '', vars: {} });
    expect(result).toMatchObject({ code: 0 });
    built.set(name, await buildTool(root, name, out));
  }
}, BUILD_TIMEOUT_MS);

describe('buildTool', () => {
  it.each(TOOLS)('the %s artifact holds only bin/<name> and tool.toml', async (name) => {
    const result = built.get(name);
    expect(result?.version).toBe('0.1.0');
    const bytes = await readFile(result?.artifact ?? '');
    expect(sha256(bytes)).toBe(result?.sha256);
    const members = unpackTar(bytes);
    expect(members.map((member) => [member.path, member.mode, member.type])).toEqual([
      [`bin/${name}`, 0o755, '0'],
      ['tool.toml', 0o644, '0'],
    ]);
    expect(members[1]?.content.toString()).toBe(
      await readFile(join(root, 'tools', name, 'tool.toml'), 'utf8'),
    );
  });

  it.each(TOOLS)(
    'a rebuild of %s produces the same sha256',
    async (name) => {
      const again = await buildTool(root, name, await mkdtemp(join(tmpdir(), 'tbx-out-')));
      expect(again.sha256).toBe(built.get(name)?.sha256);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'two builds of the real transcribe tool into separate directories are byte-identical',
    async () => {
      const first = await buildTool(
        REPO_ROOT,
        'transcribe',
        await mkdtemp(join(tmpdir(), 'tbx-a-')),
      );
      const second = await buildTool(
        REPO_ROOT,
        'transcribe',
        await mkdtemp(join(tmpdir(), 'tbx-b-')),
      );
      expect(first.artifact).not.toBe(second.artifact);
      expect((await readFile(first.artifact)).equals(await readFile(second.artifact))).toBe(true);
      expect(first.sha256).toBe(second.sha256);
    },
    BUILD_TIMEOUT_MS,
  );

  it('gzip output is byte-stable across platforms (fixed OS byte and mtime)', async () => {
    const bytes = await readFile(built.get('b-sh')?.artifact ?? '');
    expect(bytes.readUInt32LE(4)).toBe(0);
    expect(bytes[9]).toBe(3);
    expect(gunzipSync(bytes).length % 512).toBe(0);
  });

  it('refuses an invalid tool name before reading anything', async () => {
    await expect(buildTool(root, '../x', out)).rejects.toThrow(/invalid tool name/);
  });

  it('built tools install and run with the checkout gone', async () => {
    const entries: IndexEntry[] = TOOLS.map(([name]) => {
      const result = built.get(name);
      return {
        name,
        version: result?.version ?? '',
        artifact: `${name}-${result?.version ?? ''}.tar.gz`,
        sha256: result?.sha256 ?? '',
      };
    });
    const index = await writeIndex(out, entries);
    const home = await mkdtemp(join(tmpdir(), 'tbx-home-'));
    for (const [name] of TOOLS) await installTool({ name, index, home, env: {} });
    await rm(root, { recursive: true, force: true });
    for (const [name] of TOOLS) {
      const link = join(home, '.local/share/tbx/bin', name);
      const stdout = execFileSync(link, ['--json'], {
        encoding: 'utf8',
        cwd: home,
        env: { PATH: process.env.PATH ?? '', HOME: home },
      });
      expect(JSON.parse(stdout)).toBe(name);
    }
  });
});

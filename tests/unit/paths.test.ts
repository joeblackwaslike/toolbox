import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareText } from '../../shared/ts/src/gen/files.ts';
import { binariesOnPath, isWithin, tbxBinDir } from '../../shared/ts/src/paths.ts';

const EXECUTABLE = 0o755;

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'tbx-path-')));
}

async function executable(file: string): Promise<string> {
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, EXECUTABLE);
  return file;
}

describe('binariesOnPath', () => {
  it('lists each executable name once, first PATH entry wins, skipping missing directories', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await executable(join(root, 'a/git'));
    await executable(join(root, 'b/git'));
    await executable(join(root, 'b/jq'));
    const path = [join(root, 'a'), join(root, 'missing'), '', join(root, 'b')].join(delimiter);
    expect(await binariesOnPath(path)).toEqual([
      { name: 'git', path: join(root, 'a/git') },
      { name: 'jq', path: join(root, 'b/jq') },
    ]);
  });

  it('ignores non-executable files, directories and broken symlinks but follows a symlink to an executable', async () => {
    const root = await tempDir();
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'plain'), 'not executable\n');
    await mkdir(join(bin, 'folder'));
    await chmod(join(bin, 'folder'), EXECUTABLE);
    await symlink(join(root, 'gone'), join(bin, 'broken'));
    await symlink(await executable(join(root, 'real')), join(bin, 'linked'));
    expect(await binariesOnPath(bin)).toEqual([{ name: 'linked', path: join(bin, 'linked') }]);
  });

  it('skips PATH entries inside an excluded root and executables that resolve into one', async () => {
    const root = await tempDir();
    const repo = join(root, 'repo');
    const managed = join(root, 'managed');
    const bin = join(root, 'bin');
    for (const dir of [join(repo, 'node_modules/.bin'), managed, bin]) {
      await mkdir(dir, { recursive: true });
    }
    await executable(join(repo, 'node_modules/.bin/biome'));
    await executable(join(managed, 'demo'));
    await symlink(await executable(join(repo, 'shim')), join(bin, 'shim'));
    await executable(join(bin, 'jq'));
    const path = [join(repo, 'node_modules/.bin'), managed, bin].join(delimiter);
    expect(await binariesOnPath(path, [repo, managed])).toEqual([
      { name: 'jq', path: join(bin, 'jq') },
    ]);
  });
});

describe('tbxBinDir', () => {
  it('prefers TBX_BIN_DIR, then XDG_DATA_HOME, then ~/.local/share', () => {
    expect(tbxBinDir({ TBX_BIN_DIR: '/x/bin', XDG_DATA_HOME: '/d', HOME: '/h' })).toBe('/x/bin');
    expect(tbxBinDir({ XDG_DATA_HOME: '/d', HOME: '/h' })).toBe('/d/tbx/bin');
    expect(tbxBinDir({ HOME: '/h' })).toBe('/h/.local/share/tbx/bin');
  });
});

describe('isWithin', () => {
  it('counts a child named ..foo as inside and a parent or sibling as outside', () => {
    expect(isWithin('/a', '/a/..foo')).toBe(true);
    expect(isWithin('/a', '/a/..foo/bar')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/a', '/a/../b')).toBe(false);
    expect(isWithin('/a', '/')).toBe(false);
    expect(isWithin('/a', '/ab')).toBe(false);
  });
});

describe('compareText', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    expect(['b', 'a', 'B', '_x', 'é'].sort(compareText)).toEqual(['B', '_x', 'a', 'b', 'é']);
    expect(compareText('a', 'a')).toBe(0);
  });
});

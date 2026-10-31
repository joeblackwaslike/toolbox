import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TarMember } from '../../tbx/src/archive.ts';
import { installTool, uninstallTool } from '../../tbx/src/commands/install.ts';
import {
  type Sandbox,
  TOOL,
  exists,
  layout,
  members,
  publish,
  runBinary,
  sandbox,
  tamper,
} from '../helpers/release.ts';

const NO_ENV = {};

let box: Sandbox;
let paths: ReturnType<typeof layout>;

function install(index: string, extra: { lockTimeoutMs?: number } = {}): Promise<void> {
  return installTool({ name: TOOL, index, home: box.home, env: NO_ENV, ...extra });
}

async function installedVersion(): Promise<string | undefined> {
  const state = JSON.parse(await readFile(paths.state, 'utf8')) as {
    tools: Record<string, { version: string; installedAt: string }>;
  };
  return state.tools[TOOL]?.version;
}

async function versions(): Promise<string[]> {
  return (await readdir(paths.tools)).sort();
}

async function writeLock(pid: number): Promise<void> {
  await mkdir(dirname(paths.lock), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ pid, createdAt: new Date().toISOString() }));
}

function deadPid(): number {
  const child = spawnSync('true');
  return child.pid ?? 999_999;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  box = await sandbox();
  paths = layout(box.home);
});

describe('installTool', () => {
  it('installs a version directory, links its binary and records the version', async () => {
    await install(await publish(box, '1.0.0'));
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
    expect(await readlink(paths.link)).toBe(join(paths.tools, '1.0.0', 'bin', TOOL));
    expect(await installedVersion()).toBe('1.0.0');
    expect(await exists(paths.lock)).toBe(false);
  });

  it('install rejects a tampered artifact (checksum mismatch)', async () => {
    const index = await publish(box, '1.0.0');
    await tamper(box, '1.0.0');
    await expect(install(index)).rejects.toThrow(/checksum mismatch/);
    expect(await exists(paths.tools)).toBe(false);
    expect(await exists(paths.link)).toBe(false);
    expect(await exists(paths.state)).toBe(false);
    expect(await exists(paths.lock)).toBe(false);
    expect(await readdir(paths.staging).catch(() => [])).toEqual([]);
  });

  it('install keeps the previous version linked when extraction fails', async () => {
    await install(await publish(box, '1.0.0'));
    const broken = await publish(box, '2.0.0', Buffer.from('not a tarball'));
    await expect(install(broken)).rejects.toThrow(/artifact/);
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
    expect(await installedVersion()).toBe('1.0.0');
    expect(await versions()).toEqual(['1.0.0']);
    expect(await readdir(paths.staging)).toEqual([]);
  });

  it('a second concurrent install waits for the lock', async () => {
    const index = await publish(box, '1.0.0');
    await writeLock(process.pid);
    let settled = false;
    const pending = install(index).finally(() => {
      settled = true;
    });
    await delay(400);
    expect(settled).toBe(false);
    expect(await exists(paths.link)).toBe(false);
    await rm(paths.lock);
    await pending;
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
  });

  it('takes over a stale lock whose owner is no longer running', async () => {
    await writeLock(deadPid());
    await install(await publish(box, '1.0.0'), { lockTimeoutMs: 1000 });
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
    expect(await exists(paths.lock)).toBe(false);
  });

  it('fails with a clear message when the lock is never released', async () => {
    await writeLock(process.pid);
    await expect(install(await publish(box, '1.0.0'), { lockTimeoutMs: 300 })).rejects.toThrow(
      new RegExp(`another tbx install is running \\(pid ${process.pid}`),
    );
    expect(await exists(paths.lock)).toBe(true);
  });

  it('validates the tool name before building any path', async () => {
    const index = await publish(box, '1.0.0');
    await expect(
      installTool({ name: '../evil', index, home: box.home, env: NO_ENV }),
    ).rejects.toThrow(/invalid tool name/);
    expect(await readdir(box.home)).toEqual([]);
  });

  const unsafe: [string, TarMember][] = [
    ['a path that climbs out', { path: '../evil', content: Buffer.from('x'), mode: 0o644 }],
    ['an absolute path', { path: '/tmp/tbx-evil', content: Buffer.from('x'), mode: 0o644 }],
    ['an unexpected member', { path: 'bin/other', content: Buffer.from('x'), mode: 0o755 }],
  ];

  it.each(unsafe)('refuses an artifact with %s', async (_label, extra) => {
    await expect(
      install(await publish(box, '1.0.0', [...members('1.0.0'), extra])),
    ).rejects.toThrow(/not allowed/);
    expect(await exists(paths.tools)).toBe(false);
    expect(await exists(join(paths.staging, 'evil'))).toBe(false);
  });

  it.each([
    ['symlink', '2'],
    ['hardlink', '1'],
  ])('refuses a %s member', async (_label, type) => {
    const [, toml] = members('1.0.0');
    const link: TarMember = {
      path: `bin/${TOOL}`,
      content: Buffer.alloc(0),
      mode: 0o755,
      type,
      linkname: '/bin/sh',
    };
    await expect(install(await publish(box, '1.0.0', [link, toml as TarMember]))).rejects.toThrow(
      /not allowed/,
    );
    expect(await exists(paths.tools)).toBe(false);
  });

  it('refuses an artifact whose tool.toml names another version', async () => {
    const index = await publish(box, '2.0.0', members('1.0.0'));
    await expect(install(index)).rejects.toThrow(
      /hello version 1\.0\.0, index says hello version 2\.0\.0/,
    );
    expect(await exists(paths.tools)).toBe(false);
  });

  it('reinstalling the installed version is a no-op that succeeds', async () => {
    const index = await publish(box, '1.0.0');
    await install(index);
    const before = await readFile(paths.state, 'utf8');
    await install(index);
    expect(await readFile(paths.state, 'utf8')).toBe(before);
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
  });

  it('refuses a different artifact for a version that is already installed', async () => {
    await install(await publish(box, '1.0.0'));
    const changed = members('1.0.0');
    changed[0] = {
      ...(changed[0] as TarMember),
      content: Buffer.from('#!/bin/sh\necho changed\n'),
    };
    await expect(install(await publish(box, '1.0.0', changed))).rejects.toThrow(/immutable/);
    expect(runBinary(paths.link)).toBe('hello 1.0.0');
  });

  it('an update keeps the previous version and prunes anything older', async () => {
    await install(await publish(box, '1.0.0'));
    await install(await publish(box, '2.0.0'));
    expect(runBinary(paths.link)).toBe('hello 2.0.0');
    expect(await versions()).toEqual(['1.0.0', '2.0.0']);
    await install(await publish(box, '3.0.0'));
    expect(await versions()).toEqual(['2.0.0', '3.0.0']);
    expect(await installedVersion()).toBe('3.0.0');
  });

  it('honours XDG_DATA_HOME, XDG_STATE_HOME and TBX_BIN_DIR', async () => {
    const env = {
      XDG_DATA_HOME: join(box.home, 'data'),
      XDG_STATE_HOME: join(box.home, 'state'),
      TBX_BIN_DIR: join(box.home, 'bin'),
    };
    await installTool({ name: TOOL, index: await publish(box, '1.0.0'), home: box.home, env });
    expect(runBinary(join(env.TBX_BIN_DIR, TOOL))).toBe('hello 1.0.0');
    expect(await exists(join(env.XDG_DATA_HOME, 'tbx/tools', TOOL, '1.0.0'))).toBe(true);
    expect(await exists(join(env.XDG_STATE_HOME, 'tbx/installed.json'))).toBe(true);
    expect(await exists(join(box.home, '.local'))).toBe(false);
  });

  it('renders units into the version directory and never into the system', async () => {
    const unit = '[unit]\nkind = "schedule"\ninterval = 60\nrunAtLoad = false\n';
    await install(await publish(box, '1.0.0', members('1.0.0', unit)));
    const units = join(paths.tools, '1.0.0', 'units');
    const files = (await readdir(units)).sort();
    const isMac = process.platform === 'darwin';
    expect(files).toEqual(
      isMac ? ['dev.tbx.hello.plist'] : ['dev.tbx.hello.service', 'dev.tbx.hello.timer'],
    );
    const text = await readFile(join(units, files[0] as string), 'utf8');
    expect(text).toContain(paths.link);
    expect(await exists(join(box.home, 'Library/LaunchAgents'))).toBe(false);
    expect(await exists(join(box.home, '.config/systemd'))).toBe(false);
  });

  it('refuses a tool that does not support this platform', async () => {
    const other = process.platform === 'darwin' ? 'linux' : 'macos';
    const parts = members('1.0.0');
    parts[1] = {
      ...(parts[1] as TarMember),
      content: Buffer.from(
        (parts[1] as TarMember).content
          .toString()
          .replace(/platforms = .*/, `platforms = ["${other}"]`),
      ),
    };
    await expect(install(await publish(box, '1.0.0', parts))).rejects.toThrow(/does not support/);
    expect(await exists(paths.tools)).toBe(false);
  });
});

describe('uninstallTool', () => {
  it('removes the link, the state entry and every version directory', async () => {
    await install(await publish(box, '1.0.0'));
    await install(await publish(box, '2.0.0'));
    await uninstallTool({ name: TOOL, home: box.home, env: NO_ENV });
    expect(await exists(paths.link)).toBe(false);
    expect(await exists(paths.tools)).toBe(false);
    expect(await installedVersion()).toBeUndefined();
  });

  it('fails for a tool that is not installed', async () => {
    await expect(uninstallTool({ name: TOOL, home: box.home, env: NO_ENV })).rejects.toThrow(
      /hello is not installed/,
    );
  });
});

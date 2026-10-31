import { lstat, readdir, readlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOpen } from '../../shared/ts/src/run.ts';
import { ALLOWED_COMMANDS, createIsolatedEnv } from '../../tbx/src/isolated-env.ts';
import { exists } from '../helpers/release.ts';

const REAL_HOMES = [homedir(), userInfo().homedir].filter((home) => home.length > 1);

function inside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..');
}

describe('createIsolatedEnv', () => {
  it('isolated env never exposes the real HOME', async () => {
    const isolated = await createIsolatedEnv();
    try {
      const { env, home } = isolated;
      expect(env.HOME).toBe(home);
      for (const real of REAL_HOMES) {
        for (const [key, value] of Object.entries(env)) {
          expect(value?.includes(real), `${key}=${value ?? ''}`).toBe(false);
        }
      }
      for (const key of [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TBX_BIN_DIR',
        'TMPDIR',
      ]) {
        expect(inside(env[key] ?? '', home), key).toBe(true);
      }
      const printed = await runOpen('env', [], { env, cwd: home });
      expect(printed.status).toBe(0);
      for (const real of REAL_HOMES) expect(printed.stdout).not.toContain(real);
      const expanded = await runOpen(
        'python3',
        ['-I', '-c', 'import os; print(os.path.expanduser("~"))'],
        { env, cwd: home },
      );
      expect(expanded.stdout.trim()).toBe(home);
    } finally {
      await isolated.cleanup();
    }
  });

  it('puts only allowlisted command links on PATH and cleans up idempotently', async () => {
    const isolated = await createIsolatedEnv();
    const entries = (isolated.env.PATH ?? '').split(delimiter);
    expect(entries).toHaveLength(1);
    const [stubs = ''] = entries;
    const names = await readdir(stubs);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(ALLOWED_COMMANDS).toContain(name);
      expect((await lstat(join(stubs, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(stubs, name))).not.toBe('');
    }
    expect(names).toEqual(expect.arrayContaining(['sh', 'bash', 'env', 'python3', 'bun']));
    expect(await runOpen('git', ['--version'], { env: isolated.env }).catch(() => null)).toBe(null);
    await isolated.cleanup();
    await isolated.cleanup();
    expect(await exists(isolated.home)).toBe(false);
    expect(await exists(stubs)).toBe(false);
  });
});

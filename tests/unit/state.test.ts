import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../shared/ts/src/errors.ts';
import { tbxPaths, withLock } from '../../tbx/src/state.ts';

function deadPid(): number {
  return spawnSync('true').pid ?? 999_999;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function staleLock(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
  const file = join(dir, 'install.lock');
  await writeFile(file, JSON.stringify({ pid: deadPid(), createdAt: new Date().toISOString() }));
  return file;
}

describe('withLock', () => {
  it('two waiters racing a stale lock never hold it at the same time', async () => {
    const file = await staleLock();
    let active = 0;
    let maxActive = 0;
    const body = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(150);
      active -= 1;
    };
    let releaseFirst: () => void = () => undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAtClaim: () => void = () => undefined;
    const firstReachedClaim = new Promise<void>((resolve) => {
      firstAtClaim = resolve;
    });
    let paused = false;
    const first = withLock(file, body, 3000, {
      beforeStaleClaim: async () => {
        if (paused) return;
        paused = true;
        firstAtClaim();
        await firstPaused;
      },
    });
    await firstReachedClaim;
    const second = withLock(
      file,
      async () => {
        releaseFirst();
        await body();
      },
      3000,
    );
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    const leftovers = (await readdir(dirname(file))).filter((name) =>
      /\.takeover|\.tmp$/.test(name),
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps one holder at a time when waiter A resumes its stale claim after B took over and C waits', async () => {
    const file = await staleLock();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const run = async (label: string): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${label} start`);
      await delay(30);
      order.push(`${label} end`);
      active -= 1;
    };

    let resumeA: () => void = () => undefined;
    const aPaused = new Promise<void>((resolve) => {
      resumeA = resolve;
    });
    let aAtClaim: () => void = () => undefined;
    const aReachedClaim = new Promise<void>((resolve) => {
      aAtClaim = resolve;
    });
    const a = withLock(file, () => run('A'), 3000, {
      beforeStaleClaim: async () => {
        aAtClaim();
        await aPaused;
      },
    });
    await aReachedClaim;

    let resumeB: () => void = () => undefined;
    const bPaused = new Promise<void>((resolve) => {
      resumeB = resolve;
    });
    let bAtAcquire: () => void = () => undefined;
    const bReachedAcquire = new Promise<void>((resolve) => {
      bAtAcquire = resolve;
    });
    const b = withLock(file, () => run('B'), 3000, {
      afterAcquire: async () => {
        bAtAcquire();
        await bPaused;
      },
    });
    await bReachedAcquire;

    resumeA();
    const c = withLock(file, () => run('C'), 3000);

    await delay(60);
    resumeB();
    await Promise.all([a, b, c]);

    expect(maxActive).toBe(1);
    expect(order.slice(0, 2)).toEqual(['B start', 'B end']);
    expect(new Set(order)).toEqual(
      new Set(['A start', 'A end', 'B start', 'B end', 'C start', 'C end']),
    );
    expect(await readdir(dirname(file))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an EACCES while removing the lock does not replace the body's error",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
      const lockDir = join(dir, 'state');
      await mkdir(lockDir);
      const file = join(lockDir, 'install.lock');
      try {
        await expect(
          withLock(file, async () => {
            await chmod(lockDir, 0o000);
            throw new Error('body failed');
          }),
        ).rejects.toThrow('body failed');
      } finally {
        await chmod(lockDir, 0o755);
      }
    },
  );
});

const HARD_DEADLINE_MS = 3000;
const SHORT_TIMEOUT_MS = 500;
const AGED_MS = 10_000;

async function stalledTakeover(mutexBody: string, ageMs = 0): Promise<string> {
  const file = await staleLock();
  const mutex = `${file}.takeover`;
  await writeFile(mutex, mutexBody);
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(mutex, then, then);
  }
  return file;
}

function mutexOwner(pid: number, ageMs: number): string {
  return JSON.stringify({ pid, createdAt: new Date(Date.now() - ageMs).toISOString(), token: 't' });
}

describe('a takeover mutex left behind', () => {
  it(
    'a fresh mutex from a dead pid makes acquire time out at timeoutMs, without spinning',
    async () => {
      const file = await stalledTakeover(mutexOwner(deadPid(), 0));
      const started = Date.now();
      const error = await withLock(file, () => Promise.resolve(), SHORT_TIMEOUT_MS).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ToolError);
      expect(error).toMatchObject({ code: 69 });
      expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS + 1000);
    },
    HARD_DEADLINE_MS,
  );

  it(
    'a mutex older than the stale age is cleared even when its pid is alive',
    async () => {
      const file = await stalledTakeover(mutexOwner(1, AGED_MS), AGED_MS);
      await expect(withLock(file, () => Promise.resolve('ran'), SHORT_TIMEOUT_MS)).resolves.toBe(
        'ran',
      );
      expect(await readdir(dirname(file))).toEqual([]);
    },
    HARD_DEADLINE_MS,
  );

  it(
    'a mutex with unparseable content older than the stale age is cleared',
    async () => {
      const file = await stalledTakeover('not json', AGED_MS);
      await expect(withLock(file, () => Promise.resolve('ran'), SHORT_TIMEOUT_MS)).resolves.toBe(
        'ran',
      );
      expect(await readdir(dirname(file))).toEqual([]);
    },
    HARD_DEADLINE_MS,
  );

  it(
    'a fresh mutex with unparseable content makes acquire time out instead of hanging',
    async () => {
      const file = await stalledTakeover('not json');
      await expect(withLock(file, () => Promise.resolve(), SHORT_TIMEOUT_MS)).rejects.toMatchObject(
        {
          code: 69,
        },
      );
    },
    HARD_DEADLINE_MS,
  );
});

describe('releasing the lock', () => {
  it(
    'a same-process waiter cannot take over while the holder is removing its lock',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
      const file = join(dir, 'install.lock');
      let resumeA: () => void = () => undefined;
      const aPaused = new Promise<void>((resolve) => {
        resumeA = resolve;
      });
      let aAtRelease: () => void = () => undefined;
      const aReachedRelease = new Promise<void>((resolve) => {
        aAtRelease = resolve;
      });
      const a = withLock(file, () => Promise.resolve(), 3000, {
        beforeReleaseRemove: async () => {
          aAtRelease();
          await aPaused;
        },
      });
      let lockDuringB: string | null = null;
      const bStarted = aReachedRelease.then(() =>
        withLock(
          file,
          async () => {
            await a;
            lockDuringB = await readFile(file, 'utf8').catch(() => null);
          },
          3000,
        ),
      );
      await aReachedRelease;
      await delay(300);
      resumeA();
      await Promise.all([a, bStarted]);
      expect(lockDuringB).not.toBeNull();
    },
    HARD_DEADLINE_MS,
  );
});

describe('a lock left behind by this process', () => {
  it('is taken over when no body in this process holds it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
    const file = join(dir, 'install.lock');
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: 'leaked' }),
    );
    await expect(withLock(file, () => Promise.resolve('ran'), 300)).resolves.toBe('ran');
  });

  it('a same-process waiter cannot take over between creating the lock and running the body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
    const file = join(dir, 'install.lock');
    const order: string[] = [];
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached: () => void = () => undefined;
    const atWindow = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const first = withLock(
      file,
      async () => {
        order.push('first start');
        await delay(50);
        order.push('first end');
      },
      3000,
      {
        afterAcquire: async () => {
          reached();
          await paused;
        },
      },
    );
    await atWindow;
    const second = withLock(
      file,
      () => {
        order.push('second');
        return Promise.resolve();
      },
      3000,
    );
    await delay(200);
    resume();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('still makes a second caller in this process wait for a body that holds it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-lock-'));
    const file = join(dir, 'install.lock');
    const order: string[] = [];
    let acquired: () => void = () => undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = withLock(
      file,
      async () => {
        order.push('first start');
        await delay(200);
        order.push('first end');
      },
      3000,
      { afterAcquire: async () => acquired() },
    );
    await lockAcquired;
    const second = withLock(file, () => {
      order.push('second');
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });
});

describe('tbxPaths', () => {
  it('ignores relative XDG values, as the XDG spec requires', () => {
    const paths = tbxPaths('/home/u', {
      XDG_DATA_HOME: 'relative/data',
      XDG_STATE_HOME: './state',
    });
    expect(paths.tools).toBe('/home/u/.local/share/tbx/tools');
    expect(paths.bin).toBe('/home/u/.local/share/tbx/bin');
    expect(paths.stateFile).toBe('/home/u/.local/state/tbx/installed.json');
  });
});

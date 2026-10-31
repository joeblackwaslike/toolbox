import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInPty } from '../../shared/ts/src/pty.ts';

const ENV = { PATH: process.env.PATH ?? '' };
const DEADLINE_MS = 10_000;
const SHORT_DEADLINE_MS = 2000;
const POLL_MS = 50;
const GONE_WITHIN_MS = 3000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !alive(pid);
}

describe('runInPty', () => {
  it('runs the command on a terminal and returns its exit code', async () => {
    const result = await runInPty(['sh', '-c', 'test -t 0 && test -t 1 && echo on-a-tty; exit 3'], {
      env: ENV,
      deadlineMs: DEADLINE_MS,
    });
    expect(result).toMatchObject({ code: 3, timedOut: false, started: true });
    expect(result.output).toContain('on-a-tty');
    expect(result.output).not.toContain('tbx-pty-started');
  });

  it('feeds input to the session as typed lines', async () => {
    const result = await runInPty(['sh', '-c', 'read a; read b; echo "got:$a,$b"'], {
      env: ENV,
      input: 'one\ntwo\n',
      deadlineMs: DEADLINE_MS,
    });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.output).toContain('got:one,two');
  });

  it.each([
    ['kills a session that never exits at the deadline, children included', ''],
    ['escalates to SIGKILL when the session ignores SIGHUP', 'trap "" HUP; '],
  ])('%s', async (_name, prefix) => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-pty-'));
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    const script = `${prefix}sleep 60 & echo $! > '${pidFile}'; wait`;
    const result = await runInPty(['sh', '-c', script], {
      env: ENV,
      deadlineMs: SHORT_DEADLINE_MS,
    });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(result).toMatchObject({ code: null, timedOut: true });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await goneWithin(pid, GONE_WITHIN_MS)).toBe(true);
  });

  it('reports a command that cannot start as exit 127 on a started pty, not a hang', async () => {
    const result = await runInPty(['tbx-no-such-command'], { env: ENV, deadlineMs: DEADLINE_MS });
    expect(result).toMatchObject({ code: 127, timedOut: false, started: true });
  });

  it('reports started: false when the pty driver fails before the pty exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-pty-'));
    const bogus = join(dir, 'python3');
    await writeFile(bogus, '#!/bin/sh\necho "OSError: out of pty devices" >&2\nexit 1\n');
    await chmod(bogus, 0o755);
    const result = await runInPty(['sh', '-c', 'exit 0'], {
      env: { PATH: [dir, ENV.PATH].join(delimiter) },
      deadlineMs: DEADLINE_MS,
    });
    expect(result).toMatchObject({ code: 1, timedOut: false, started: false });
    expect(result.output).toContain('out of pty devices');
  });

  it('resolves, without an EPIPE crash, when the driver exits before reading its input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-pty-'));
    const bogus = join(dir, 'python3');
    await writeFile(bogus, '#!/bin/sh\nexec 0<&-\nexit 1\n');
    await chmod(bogus, 0o755);
    const result = await runInPty(['sh', '-c', 'exit 0'], {
      env: { PATH: [dir, ENV.PATH].join(delimiter) },
      input: 'y\n'.repeat(1 << 20),
      deadlineMs: DEADLINE_MS,
    });
    expect(result).toMatchObject({ code: 1, timedOut: false, started: false });
  });
});

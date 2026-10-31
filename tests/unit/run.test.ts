import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError, runBounded, runOpen, signalGroup } from '../../shared/ts/src/run.ts';

const SHORT_LIMIT_MS = 200;
const QUICK_MS = 5000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signalGroup', () => {
  it('never signals for a missing pid or pid 0 or 1, which would hit the caller or init', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const pid of [undefined, 0, 1, -5]) signalGroup(pid, 'SIGKILL');
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals the whole process group of a real pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    signalGroup(4242, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });
});

describe('runOpen', () => {
  it('closes stdin when asked, so a command reading it sees EOF', async () => {
    const closed = await runOpen('cat', [], { closeStdin: true, timeoutMs: QUICK_MS });
    expect(closed).toMatchObject({ status: 0, timedOut: false });
  });
});

describe('runBounded', () => {
  it('returns the output of a command that succeeds', async () => {
    await expect(runBounded('printf', ['hi'], { timeoutMs: QUICK_MS })).resolves.toMatchObject({
      stdout: 'hi',
    });
  });

  it('kills a command that outlives its limit and says so', async () => {
    const started = Date.now();
    const error: unknown = await runBounded('sleep', ['30'], { timeoutMs: SHORT_LIMIT_MS }).catch(
      (thrown: unknown) => thrown,
    );
    expect(Date.now() - started).toBeLessThan(QUICK_MS);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ timedOut: true, stderr: 'timed out after 0.2s' });
    expect((error as Error).message).toBe('sleep 30 timed out after 0.2s');
  });

  it('rejects a non-zero exit with its stderr', async () => {
    const error: unknown = await runBounded('sh', ['-c', 'echo bad >&2; exit 3'], {
      timeoutMs: QUICK_MS,
    }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ timedOut: false, status: 3, stderr: 'bad\n' });
  });

  it('rejects a missing command with ENOENT', async () => {
    await expect(
      runBounded('tbx-no-such-command', [], { timeoutMs: QUICK_MS }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

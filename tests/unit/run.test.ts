import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandError,
  MAX_CAPTURE_BYTES,
  runBounded,
  runOpen,
  signalGroup,
} from '../../shared/ts/src/run.ts';

const SHORT_LIMIT_MS = 200;
const RETURN_SLACK_MS = 1500;
const HARD_DEADLINE_MS = 5000;
const ESCAPED_HOLDER = [
  "perl -e 'use POSIX; pipe(my $r, my $w); my $pid = fork;",
  'if ($pid) { close $w; <$r>; print "escaped $pid\\n"; exit 0 }',
  "close $r; POSIX::setsid(); close $w; exec q(sleep), q(30)'",
].join(' ');

function killEscaped(stdout: string): void {
  const pid = Number(/escaped (\d+)/.exec(stdout)?.[1]);
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}
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

  it('decodes a multibyte character split across two chunks', async () => {
    const split = await runOpen(
      'sh',
      ['-c', String.raw`printf '\342'; sleep 0.2; printf '\202\254\n'`],
      {
        closeStdin: true,
        timeoutMs: QUICK_MS,
      },
    );
    expect(split.stdout).toBe('€\n');
  });

  it('truncates output over the capture cap, marks it and kills the command', async () => {
    const result = await runOpen('sh', ['-c', 'while :; do echo aaaaaaaaaaaaaaaa; done'], {
      closeStdin: true,
      timeoutMs: QUICK_MS,
      maxCaptureBytes: 1000,
    });
    expect(result).toMatchObject({ truncated: true, timedOut: false });
    expect(result.stdout.length).toBe(1000);
  });

  it(
    'returns at the timeout even when an escaped process keeps the pipes open',
    async () => {
      const started = Date.now();
      const result = await runOpen('sh', ['-c', `${ESCAPED_HOLDER}; echo before; sleep 30`], {
        closeStdin: true,
        timeoutMs: SHORT_LIMIT_MS,
      });
      killEscaped(result.stdout);
      expect(result).toMatchObject({ timedOut: true, status: null });
      expect(Date.now() - started).toBeLessThan(SHORT_LIMIT_MS + RETURN_SLACK_MS);
      expect(result.stdout).toContain('before');
    },
    HARD_DEADLINE_MS,
  );

  it(
    'returns after an output-cap kill even when an escaped process keeps the pipes open',
    async () => {
      const started = Date.now();
      const result = await runOpen(
        'sh',
        ['-c', `${ESCAPED_HOLDER}; while :; do echo aaaaaaaaaaaaaaaa; done`],
        { closeStdin: true, timeoutMs: QUICK_MS, maxCaptureBytes: 4000 },
      );
      killEscaped(result.stdout);
      expect(result).toMatchObject({ truncated: true, timedOut: false });
      expect(Date.now() - started).toBeLessThan(RETURN_SLACK_MS * 2);
    },
    HARD_DEADLINE_MS,
  );

  it(
    'returns at the timeout when the command exits early but an escaped process keeps the pipes open',
    async () => {
      const started = Date.now();
      const result = await runOpen('sh', ['-c', `${ESCAPED_HOLDER}; echo before; exit 0`], {
        closeStdin: true,
        timeoutMs: SHORT_LIMIT_MS,
      });
      killEscaped(result.stdout);
      expect(result).toMatchObject({ timedOut: true, status: 0 });
      expect(Date.now() - started).toBeLessThan(SHORT_LIMIT_MS + RETURN_SLACK_MS);
      expect(result.stdout).toContain('before');
    },
    HARD_DEADLINE_MS,
  );

  it('still returns every byte of a command that exits normally', async () => {
    const result = await runOpen('sh', ['-c', 'yes 0123456789 | head -c 300000; echo done >&2'], {
      closeStdin: true,
      timeoutMs: QUICK_MS,
    });
    expect(result).toMatchObject({ status: 0, timedOut: false, truncated: false });
    expect(result.stdout).toHaveLength(300_000);
    expect(result.stderr).toBe('done\n');
  });

  it('keeps the default cap at 8 MiB', () => {
    expect(MAX_CAPTURE_BYTES).toBe(8 * 1024 * 1024);
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

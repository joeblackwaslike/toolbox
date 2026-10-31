import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Most bytes of output `runOpen` and `runInPty` keep from one command, over all its streams. */
export const MAX_CAPTURE_BYTES = 8_388_608;

/** Result of running a command with `runOpen`. */
export interface RunResult {
  /** Exit code, or `null` when the command was killed by a signal, the timeout or the cap. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the timeout passed and the command was killed. */
  timedOut: boolean;
  /** True when the output passed the capture cap: the rest was dropped and the command killed. */
  truncated: boolean;
}

/** Text read so far from each captured stream, and whether the cap cut it short. */
export interface CapturedOutput {
  texts: string[];
  truncated: boolean;
}

/**
 * Reads `streams` as UTF-8 (a character split across chunks decodes whole) into
 * `CapturedOutput.texts`, keeping at most `limit` bytes over all of them. The chunk that passes
 * the cap is cut at the limit, later ones are dropped, `truncated` is set and `onOverflow` runs
 * once.
 */
export function captureOutput(
  streams: readonly Readable[],
  limit: number,
  onOverflow: () => void,
): CapturedOutput {
  const captured: CapturedOutput = { texts: streams.map(() => ''), truncated: false };
  let room = limit;
  for (const [index, stream] of streams.entries()) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (captured.truncated) return;
      const bytes = Buffer.byteLength(chunk);
      const kept = bytes <= room ? chunk : Buffer.from(chunk).subarray(0, room).toString('utf8');
      captured.texts[index] = `${captured.texts[index] ?? ''}${kept}`;
      room -= Buffer.byteLength(kept);
      if (bytes > Buffer.byteLength(kept)) {
        captured.truncated = true;
        onOverflow();
      }
    });
  }
  return captured;
}

/** Options for `runOpen` and `runBounded`. */
export interface RunOptions {
  /** Kill the command after this long; `runOpen` defaults to 15 seconds. */
  timeoutMs?: number;
  /** The whole environment of the command; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory; defaults to the current one. */
  cwd?: string;
  /** Close stdin right away instead of leaving it open, so a read sees end of input. */
  closeStdin?: boolean;
  /** Output cap in bytes; defaults to `MAX_CAPTURE_BYTES`. */
  maxCaptureBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MS_PER_SECOND = 1000;

/**
 * Sends `signal` to the process group led by `pid`. A missing pid, or one that is 1 or less, is
 * ignored: `kill(-0)` would signal the caller's own group and `kill(-1)` every process it may
 * signal. A group that has already exited is ignored too.
 */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* The group is already gone. */
  }
}

/**
 * Runs a command with stdin left open as a non-TTY pipe (unless `closeStdin`), so a command
 * that tries to prompt hangs and is killed after `timeoutMs` instead of reading EOF. The command
 * runs in its own process group and the timeout kills the whole group, so children holding its
 * output open cannot keep the call waiting. Output past `maxCaptureBytes` is dropped and the
 * group is killed (`truncated: true`). Lookup of `command` uses the `PATH` in `env`.
 *
 * @throws {Error} when the command cannot be started.
 */
export function runOpen(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const captured = captureOutput(
      [child.stdout, child.stderr],
      options.maxCaptureBytes ?? MAX_CAPTURE_BYTES,
      () => {
        signalGroup(child.pid, 'SIGKILL');
      },
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      const [stdout = '', stderr = ''] = captured.texts;
      resolve({ status, stdout, stderr, timedOut, truncated: captured.truncated });
    });
    if (options.closeStdin === true) child.stdin.end();
  });
}

/**
 * A command run by `runBounded` that exited non-zero or outlived its limit. `stderr` holds the
 * command's stderr, or `timed out after <n>s` when it was killed at the limit.
 */
export class CommandError extends Error {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(line: string, result: RunResult, limitMs: number) {
    const notice = `timed out after ${limitMs / MS_PER_SECOND}s`;
    super(
      result.timedOut
        ? `${line} ${notice}`
        : `${line} exited ${String(result.status)}: ${result.stderr.trim()}`,
    );
    this.name = 'CommandError';
    this.status = result.status;
    this.stdout = result.stdout;
    this.stderr = result.timedOut ? notice : result.stderr;
    this.timedOut = result.timedOut;
  }
}

/**
 * Runs a command with stdin closed and a hard `timeoutMs` (the whole process group is killed
 * when it passes) and returns its output when it exits 0.
 *
 * @throws {CommandError} when it exits non-zero or times out.
 * @throws {Error} from spawning, with `code` `ENOENT` when the command is not installed.
 */
export async function runBounded(
  command: string,
  args: readonly string[],
  options: RunOptions & { timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await runOpen(command, args, { ...options, closeStdin: true });
  if (result.status === 0 && !result.timedOut) {
    return { stdout: result.stdout, stderr: result.stderr };
  }
  throw new CommandError([command, ...args].join(' '), result, options.timeoutMs);
}

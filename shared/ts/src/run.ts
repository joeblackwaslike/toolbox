import { spawn } from 'node:child_process';

/** Result of running a command with `runOpen`. */
export interface RunResult {
  /** Exit code, or `null` when the command was killed by a signal or the timeout. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the timeout passed and the command was killed. */
  timedOut: boolean;
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
 * output open cannot keep the call waiting. Lookup of `command` uses the `PATH` in `env`.
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
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout, stderr, timedOut });
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

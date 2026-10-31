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

/** Options for `runOpen`. */
export interface RunOptions {
  /** Kill the command after this long; defaults to 15 seconds. */
  timeoutMs?: number;
  /** The whole environment of the command; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory; defaults to the current one. */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Runs a command with stdin left open as a non-TTY pipe, so a command that tries to prompt
 * hangs and is killed after `timeoutMs` instead of reading EOF. The command runs in its own
 * process group and the timeout kills the whole group, so children holding its output open
 * cannot keep the call waiting. Lookup of `command` uses the `PATH` in `env`.
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
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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
  });
}

import { spawn } from 'node:child_process';

/** Result of running a command with `runOpen`. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a command with stdin left open as a non-TTY pipe, so a command that tries to prompt
 * hangs and is killed after `timeoutMs` instead of reading EOF.
 */
export function runOpen(
  command: string,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

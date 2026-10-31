import { spawn } from 'node:child_process';
import { findOnPath } from './paths.ts';
import { signalGroup } from './run.ts';

/** Options for `runInPty`. */
export interface PtyOptions {
  /** The whole environment of the session; `python3` is looked up on its `PATH`. */
  env: NodeJS.ProcessEnv;
  /** Text typed into the terminal once the session starts, for example `"y\n"`. */
  input?: string;
  /** Hard limit on the session; when it passes, the session is killed. */
  deadlineMs: number;
  /** Working directory; defaults to the current one. */
  cwd?: string;
}

/** Outcome of `runInPty`. */
export interface PtyResult {
  /** Everything the session wrote to its terminal, unmodified (so lines end in `\r\n`). */
  output: string;
  /** Exit code (128 plus the signal number when killed by a signal); `null` when timed out. */
  code: number | null;
  /** True when the deadline passed and the session was killed. */
  timedOut: boolean;
  /**
   * True once the driver has created the pseudo-terminal and forked the command. False means
   * the pty never ran (for example no pty devices, or a `python3` that is not CPython 3.9+),
   * and `output` then holds the driver's own error.
   */
  started: boolean;
}

const KILL_GRACE_SECONDS = 0.5;
const BACKSTOP_MS = 3000;
const EXEC_FAILED = 127;
const STARTED = 'tbx-pty-started';

/**
 * The Python driver behind `runInPty`, run with `python3 -I -c`. It forks the command onto a
 * new pseudo-terminal (`pty.fork`, so the command leads its own session and process group),
 * copies its stdin into the terminal and the terminal to its stdout, and exits with the
 * command's exit code (128 plus the signal number for a signal). Right after the fork it writes
 * the line `STARTED` to its own stderr, which nothing else writes to unless the driver fails;
 * the command's output all arrives through the terminal on stdout. On SIGTERM it sends SIGHUP to
 * the command's process group, waits `KILL_GRACE_SECONDS`, sends SIGKILL, and exits 124.
 */
const DRIVER = `
import os, pty, select, signal, sys, time

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(sys.argv[1], sys.argv[1:])
    except OSError as error:
        os.write(2, f"{sys.argv[1]}: {error.strerror}\\n".encode())
    os._exit(${EXEC_FAILED})

os.write(2, b"${STARTED}\\n")

def stop(signum, frame):
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except OSError:
            break
        time.sleep(${KILL_GRACE_SECONDS})
    os._exit(124)

signal.signal(signal.SIGTERM, stop)
sources = [fd, 0]
while fd in sources:
    ready, _, _ = select.select(sources, [], [])
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
        else:
            sources.remove(0)
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        if data:
            os.write(1, data)
        else:
            sources.remove(fd)
code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
sys.exit(128 - code if code < 0 else code)
`;

/**
 * Runs `argv` with stdin, stdout and stderr on a pseudo-terminal, so it sees a TTY and can
 * prompt, types `input` into it, and returns what it printed and its exit code. The terminal
 * comes from Python's standard `pty` module (`DRIVER`, run by the `python3` on `env.PATH`),
 * which behaves the same under Node and Bun. At `deadlineMs` the command's whole process group
 * gets SIGHUP and then, after a short grace, SIGKILL, and the call resolves with
 * `timedOut: true`. A command that waits for more input than `input` holds therefore times out
 * instead of hanging. A command that cannot be executed exits 127 with `started: true`; a
 * driver that fails before the terminal exists gives `started: false`.
 *
 * @throws {Error} when `python3` is not on `env.PATH` or cannot be started.
 */
export async function runInPty(argv: readonly string[], options: PtyOptions): Promise<PtyResult> {
  const python = await findOnPath('python3', options.env.PATH ?? '');
  if (python === null) throw new Error('runInPty needs python3 on PATH');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-c', DRIVER, ...argv], {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let output = '';
    let driverErrors = '';
    let timedOut = false;
    let backstop: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      backstop = setTimeout(() => {
        signalGroup(child.pid, 'SIGKILL');
      }, BACKSTOP_MS);
    }, options.deadlineMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      driverErrors += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(backstop);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(backstop);
      const lines = driverErrors.split('\n');
      const started = lines.includes(STARTED);
      const errors = lines.filter((line) => line !== STARTED).join('\n');
      resolve({ output: output + errors, code: timedOut ? null : code, timedOut, started });
    });
    child.stdin.end(options.input ?? '');
  });
}

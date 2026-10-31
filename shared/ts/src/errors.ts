/**
 * Stable process exit codes shared by every tbx tool. `usage` and `unavailable` and `config`
 * follow the sysexits convention (2, 69, 78).
 */
export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  unavailable: 69,
  config: 78,
} as const;

/**
 * Error a tool throws to end the run with a specific exit code. `code` defaults to
 * `ExitCode.failure`; `cause` keeps the underlying error.
 */
export class ToolError extends Error {
  readonly code: number;

  constructor(message: string, code: number = ExitCode.failure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** True when `error` is a Node system error with a string errno `code` such as `ENOENT`. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

/** The message of an `Error`, or `String(error)` for anything else that was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

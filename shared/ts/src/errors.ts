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
 * `ExitCode.failure`.
 */
export class ToolError extends Error {
  readonly code: number;

  constructor(message: string, code: number = ExitCode.failure) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

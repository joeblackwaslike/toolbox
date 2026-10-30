/**
 * Output channel for a tool. `result` is the program's answer and goes to stdout; `info` and
 * `error` are diagnostics and go to stderr, so stdout stays machine-readable.
 */
export interface Output {
  /** Writes the result to stdout: JSON when json mode is on, otherwise strings verbatim. */
  result(data: unknown): void;
  /** Writes an informational line to stderr. */
  info(message: string): void;
  /** Writes an error line to stderr. */
  error(message: string): void;
}

function render(data: unknown, json: boolean): string {
  if (json) {
    return JSON.stringify(data);
  }
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

/**
 * Creates an `Output`. With `json: true`, `result` writes exactly one JSON document to
 * stdout.
 */
export function createOutput(options: { json: boolean }): Output {
  return {
    result(data) {
      process.stdout.write(`${render(data, options.json)}\n`);
    },
    info(message) {
      process.stderr.write(`${message}\n`);
    },
    error(message) {
      process.stderr.write(`${message}\n`);
    },
  };
}

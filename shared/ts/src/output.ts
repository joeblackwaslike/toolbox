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

/** Where an `Output` writes its text; each function receives complete lines. */
export interface OutputStreams {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** `OutputStreams` that write to `process.stdout` and `process.stderr`. */
export const PROCESS_STREAMS: OutputStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Creates an `Output`. With `json: true`, `result` writes exactly one JSON document to
 * stdout. `streams` defaults to `process.stdout` and `process.stderr`; pass your own to
 * capture output, for example in tests.
 */
export function createOutput(options: { json: boolean; streams?: OutputStreams }): Output {
  const streams = options.streams ?? PROCESS_STREAMS;
  return {
    result(data) {
      streams.stdout(`${render(data, options.json)}\n`);
    },
    info(message) {
      streams.stderr(`${message}\n`);
    },
    error(message) {
      streams.stderr(`${message}\n`);
    },
  };
}

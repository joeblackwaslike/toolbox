import { isatty } from 'node:tty';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ExitCode, ToolError, errorLines } from './errors.ts';
import {
  type ArgSpec,
  BUILTIN_OPTIONS,
  ManifestError,
  type OptSpec,
  type ToolManifest,
} from './manifest.ts';
import { type Output, createOutput } from './output.ts';

const STDIN_FD = 0;
const INTEGER_PATTERN = /^-?\d+$/;

/** A parsed option value: `bool` options give booleans, `int` numbers, `string` strings. */
export type OptionValue = string | number | boolean;

/** What a tool's run function receives once its command line has parsed. */
export interface ToolContext {
  /** Positional arguments that were given, keyed by manifest name. */
  readonly args: Record<string, string>;
  /** Option values keyed by manifest long name. Bool options are always present. */
  readonly opts: Record<string, OptionValue>;
  /** True when `--json` was given. */
  readonly json: boolean;
  /** True only when stdin is a TTY and neither `-y`/`--no-input` nor `--json` was given. */
  readonly interactive: boolean;
  /** Output channel, in JSON mode when `json` is true. */
  readonly out: Output;
}

/** The body of a tool, called after parsing succeeds. Throw `ToolError` to pick the exit code. */
export type ToolRun = (ctx: ToolContext) => Promise<void>;

/** One option in `ToolUsage`. Absent fields are `null` so every language emits the same keys. */
export interface UsageOption {
  long: string;
  short: string | null;
  summary: string;
  type: OptSpec['type'];
  default: OptionValue | null;
}

/** The manifest-derived usage that `--help --json` prints; identical for ts, py and sh tools. */
export interface ToolUsage {
  name: string;
  alias: string | null;
  summary: string;
  version: string;
  usage: string;
  args: ArgSpec[];
  options: UsageOption[];
}

function usageLine(m: ToolManifest): string {
  const operands = m.args.map((argument) =>
    argument.required ? `<${argument.name}>` : `[${argument.name}]`,
  );
  return [m.name, '[options]', ...operands].join(' ');
}

/** Builds the usage document for a manifest: its options first, then `BUILTIN_OPTIONS`. */
export function usageOf(m: ToolManifest): ToolUsage {
  return {
    name: m.name,
    alias: m.alias ?? null,
    summary: m.summary,
    version: m.version,
    usage: usageLine(m),
    args: m.args.map(({ name, summary, required }) => ({ name, summary, required })),
    options: [...m.options, ...BUILTIN_OPTIONS].map((spec) => ({
      long: spec.long,
      short: spec.short ?? null,
      summary: spec.summary,
      type: spec.type,
      default: spec.default ?? null,
    })),
  };
}

function parseInteger(value: string): number {
  if (!INTEGER_PATTERN.test(value)) {
    throw new InvalidArgumentError('must be an integer');
  }
  return Number(value);
}

function toCommanderOption(spec: OptSpec): Option {
  const shortFlag = spec.short === undefined ? '' : `-${spec.short}, `;
  const flags = `${shortFlag}--${spec.long}`;
  const option = new Option(spec.type === 'bool' ? flags : `${flags} <${spec.long}>`, spec.summary);
  if (spec.type === 'int') option.argParser(parseInteger);
  if (spec.default !== undefined) option.default(spec.default);
  return option;
}

function silent(): void {
  /* Commander output is replaced by usageError and writeHelp. */
}

function buildProgram(m: ToolManifest): Command {
  const program = new Command(m.name)
    .description(m.summary)
    .usage(usageLine(m).slice(m.name.length + 1))
    .helpOption(false)
    .exitOverride()
    .configureOutput({ writeOut: silent, writeErr: silent, outputError: silent })
    .allowExcessArguments(false)
    .action(silent);
  for (const argument of m.args) program.argument(`[${argument.name}]`, argument.summary);
  for (const spec of [...m.options, ...BUILTIN_OPTIONS]) program.addOption(toCommanderOption(spec));
  return program;
}

function isOptionValue(value: unknown): value is OptionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function optionValues(m: ToolManifest, program: Command): Record<string, OptionValue> {
  const values: Record<string, unknown> = program.opts();
  const entries = m.options.flatMap((spec): [string, OptionValue][] => {
    const value = values[toCommanderOption(spec).attributeName()];
    if (isOptionValue(value)) return [[spec.long, value]];
    return spec.type === 'bool' ? [[spec.long, false]] : [];
  });
  return Object.fromEntries(entries);
}

function argumentValues(m: ToolManifest, operands: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    m.args.flatMap((argument, index): [string, string][] => {
      const value = operands[index];
      return value === undefined ? [] : [[argument.name, value]];
    }),
  );
}

function usageError(m: ToolManifest, message: string): number {
  const out = createOutput({ json: false });
  out.error(message);
  out.error(`Usage: ${usageLine(m)}`);
  return ExitCode.usage;
}

function writeHelp(m: ToolManifest, program: Command, json: boolean): number {
  if (json) {
    createOutput({ json: true }).result(usageOf(m));
  } else {
    process.stdout.write(program.helpInformation());
  }
  return ExitCode.ok;
}

/**
 * Reports `error` on stderr and returns the exit code for it: a `ToolError` its own code, a
 * `ManifestError` 78, anything else 1 with its cause chain (see `errorLines`) and no stack.
 */
export function reportError(error: unknown, out: Output): number {
  if (error instanceof ToolError || error instanceof ManifestError) {
    out.error(`error: ${error.message}`);
    return error instanceof ToolError ? error.code : ExitCode.config;
  }
  for (const line of errorLines(error)) out.error(line);
  return ExitCode.failure;
}

async function runBody(run: ToolRun, ctx: ToolContext): Promise<number> {
  try {
    await run(ctx);
    return ExitCode.ok;
  } catch (error) {
    return reportError(error, ctx.out);
  }
}

/**
 * Parses `argv` against the manifest and calls `run`, returning the exit code instead of
 * exiting. Parse errors (unknown flag, bad value, too many or missing arguments) return
 * `ExitCode.usage` with a usage line on stderr and never prompt. `--help` wins over a missing
 * argument; `--help --json` prints `usageOf(m)`. Whatever `run` throws is reported by
 * `reportError` and its exit code returned.
 *
 * @param stdinIsTTY whether stdin is a terminal; defaults to checking file descriptor 0.
 */
export async function runTool(
  m: ToolManifest,
  run: ToolRun,
  argv: readonly string[],
  stdinIsTTY: boolean = isatty(STDIN_FD),
): Promise<number> {
  const program = buildProgram(m);
  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return usageError(m, error.message);
    throw error;
  }
  const flags: Record<string, unknown> = program.opts();
  const json = flags.json === true;
  if (flags.help === true) return writeHelp(m, program, json);
  const missing = m.args.slice(program.args.length).find((argument) => argument.required);
  if (missing !== undefined) {
    return usageError(m, `error: missing required argument '${missing.name}'`);
  }
  return runBody(run, {
    args: argumentValues(m, program.args),
    opts: optionValues(m, program),
    json,
    interactive: stdinIsTTY && flags.input !== false && !json,
    out: createOutput({ json }),
  });
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => {
      resolve();
    });
  });
}

/**
 * Runs a TypeScript tool: parses `process.argv` with `runTool`, flushes stdout and stderr,
 * then exits with the resulting code.
 */
export async function defineTool(m: ToolManifest, run: ToolRun): Promise<never> {
  let code: number;
  try {
    code = await runTool(m, run, process.argv.slice(2));
  } catch (error) {
    code = reportError(error, createOutput({ json: false }));
  }
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
}

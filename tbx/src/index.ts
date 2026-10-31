import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { ManifestError } from '../../shared/ts/src/manifest.ts';
import { type OutputStreams, PROCESS_STREAMS, createOutput } from '../../shared/ts/src/output.ts';
import { gen } from './commands/gen.ts';
import { help } from './commands/help.ts';
import { list } from './commands/list.ts';
import { newTool } from './commands/new.ts';
import { newShared, searchShared } from './commands/shared.ts';
import type { TbxContext } from './context.ts';
import { LANGS, type Lang } from './templates.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where `runTbx` works: the repo root and the PATH used for collision checks. */
export interface TbxEnv {
  /** Repo root holding `tools/`, `shared/` and `docs/`. */
  root: string;
  /** PATH searched for binaries a tool name would shadow; defaults to `process.env.PATH`. */
  path?: string;
}

/** Exit code and captured output of one `runTbx` call. */
export interface TbxResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GlobalFlags {
  json?: boolean;
}

type Body = (ctx: TbxContext) => Promise<void>;

interface NewOptions {
  lang: Lang;
  summary?: string;
}

function langOption(): Option {
  return new Option('--lang <lang>', 'Language').choices(LANGS).makeOptionMandatory();
}

function withSummary(options: NewOptions): NewOptions {
  return options.summary === undefined
    ? { lang: options.lang }
    : { lang: options.lang, summary: options.summary };
}

function buildProgram(env: TbxEnv, streams: OutputStreams): Command {
  const program = new Command('tbx')
    .description('Scaffold, document and inspect the tools in this repo')
    .option('-y, --no-input', 'Disable all prompts')
    .option('--json', 'Print machine-readable JSON to stdout')
    .helpCommand(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        streams.stdout(text);
      },
      writeErr: (text) => {
        streams.stderr(text);
      },
    });
  const run = (command: Command, body: Body): Promise<void> => {
    const json = command.optsWithGlobals<GlobalFlags>().json === true;
    const out = createOutput({ json, streams });
    return body({ root: env.root, path: env.path ?? process.env.PATH ?? '', json, out });
  };
  program
    .command('list')
    .description('List every tool in tools/')
    .action((_options: unknown, command: Command) => run(command, list));
  program
    .command('gen')
    .description('Regenerate READMEs, completions and docs; --check lists drift instead')
    .option('--check', 'Write nothing; exit 1 when a generated file is out of date')
    .action((options: { check?: boolean }, command: Command) =>
      run(command, (ctx) => gen(ctx, { check: options.check === true })),
    );
  program
    .command('new')
    .description('Scaffold tools/<name>/ with a manifest, a src entry and a failing test')
    .argument('<name>', 'Tool name')
    .addOption(langOption())
    .option('-s, --summary <summary>', 'One-line summary for tool.toml')
    .action((name: string, options: NewOptions, command: Command) =>
      run(command, (ctx) => newTool(ctx, name, withSummary(options))),
    );
  const shared = program
    .command('shared')
    .description('Search or scaffold the helpers under shared/')
    .helpCommand(false);
  shared
    .command('search')
    .description('Find public shared symbols by name or doc comment')
    .argument('<term>', 'Word to look for, ignoring case')
    .action((term: string, _options: unknown, command: Command) =>
      run(command, (ctx) => searchShared(ctx, term)),
    );
  shared
    .command('new')
    .description('Scaffold a shared module with a doc stub and a failing test')
    .argument('<name>', 'Module name')
    .addOption(langOption())
    .action((name: string, options: { lang: Lang }, command: Command) =>
      run(command, (ctx) => newShared(ctx, name, options.lang)),
    );
  program
    .command('help')
    .description("Print a tool's usage, as JSON with --json")
    .argument('<tool>', 'Tool name or alias')
    .action((tool: string, _options: unknown, command: Command) =>
      run(command, (ctx) => help(ctx, tool)),
    );
  return program;
}

function exitCodeOf(error: unknown, streams: OutputStreams): number {
  if (error instanceof CommanderError) {
    return error.exitCode === ExitCode.ok ? ExitCode.ok : ExitCode.usage;
  }
  if (error instanceof ToolError || error instanceof ManifestError) {
    streams.stderr(`error: ${error.message}\n`);
    return error instanceof ToolError ? error.code : ExitCode.config;
  }
  throw error;
}

async function execute(
  argv: readonly string[],
  env: TbxEnv,
  streams: OutputStreams,
): Promise<number> {
  try {
    await buildProgram(env, streams).parseAsync(argv, { from: 'user' });
    return ExitCode.ok;
  } catch (error) {
    return exitCodeOf(error, streams);
  }
}

/**
 * Runs `tbx` with `argv` (no program name) against `env.root` and returns the exit code with
 * the captured stdout and stderr, instead of writing to the process streams or exiting. Usage
 * errors and unknown flags exit 2; a `ToolError` exits with its code; an invalid manifest
 * exits 78.
 */
export async function runTbx(argv: string[], env: TbxEnv): Promise<TbxResult> {
  let stdout = '';
  let stderr = '';
  const code = await execute(argv, env, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

if (import.meta.main) {
  process.exitCode = await execute(process.argv.slice(2), { root: REPO_ROOT }, PROCESS_STREAMS);
}

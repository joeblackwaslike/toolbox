import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { reportError } from '../../shared/ts/src/cli.ts';
import { ExitCode } from '../../shared/ts/src/errors.ts';
import { RESERVED_COMMANDS } from '../../shared/ts/src/manifest.ts';
import { type OutputStreams, PROCESS_STREAMS, createOutput } from '../../shared/ts/src/output.ts';
import { binariesOnPath, tbxBinDir } from '../../shared/ts/src/paths.ts';
import version from '../version.txt' with { type: 'text' };
import { build } from './commands/build.ts';
import { gen } from './commands/gen.ts';
import { help } from './commands/help.ts';
import { install, installedToolFor, uninstall } from './commands/install.ts';
import { list } from './commands/list.ts';
import { newTool } from './commands/new.ts';
import { newShared, searchShared } from './commands/shared.ts';
import { stamp } from './commands/stamp.ts';
import { update } from './commands/update.ts';
import { verify } from './commands/verify.ts';
import { type TbxContext, isCi } from './context.ts';
import { tbxPaths } from './state.ts';
import { LANGS, type Lang } from './templates.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where `runTbx` works: the repo root, PATH and environment used for collision checks. */
export interface TbxEnv {
  /** Repo root holding `tools/`, `shared/` and `docs/`. */
  root: string;
  /** PATH searched for binaries a tool name would shadow; defaults to `vars.PATH`. */
  path?: string;
  /** Environment for `CI`, `TBX_BIN_DIR`, `XDG_DATA_HOME` and `HOME`; defaults to `process.env`. */
  vars?: Readonly<Record<string, string | undefined>>;
}

function homeOf(variables: Readonly<Record<string, string | undefined>>): string {
  return variables.HOME === undefined || variables.HOME === '' ? homedir() : variables.HOME;
}

function contextBase(env: TbxEnv): Omit<TbxContext, 'json' | 'out'> {
  const variables = env.vars ?? process.env;
  const pathVariable = env.path ?? variables.PATH ?? '';
  return {
    root: env.root,
    home: homeOf(variables),
    env: variables,
    ci: isCi(variables),
    pathBinaries: () => binariesOnPath(pathVariable, [env.root, tbxBinDir(variables)]),
  };
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

type Runner = (command: Command, body: Body) => Promise<void>;

function addReleaseCommands(program: Command, run: Runner): void {
  program
    .command('build')
    .description('Build tools into self-contained artifacts and a release index.json')
    .argument('<name>', 'Tool name, or all')
    .option('-o, --out <dir>', 'Output directory (default: dist/release)')
    .action((name: string, options: { out?: string }, command: Command) =>
      run(command, (ctx) => build(ctx, name, options)),
    );
  program
    .command('install')
    .description('Install tools from a release index into the managed bin directory')
    .argument('<name>', 'Tool name, or all')
    .option(
      '--index <path|url>',
      'Release index.json path or URL (default: $TBX_INDEX, else the GitHub release index)',
    )
    .action((name: string, options: { index?: string }, command: Command) =>
      run(command, (ctx) => install(ctx, name, options)),
    );
  program
    .command('update')
    .description('Install newer versions of installed tools from a release index')
    .argument('[name]', 'Tool name (default: every installed tool)')
    .option(
      '--index <path|url>',
      'Release index.json path or URL (default: $TBX_INDEX, else the GitHub release index)',
    )
    .action((name: string | undefined, options: { index?: string }, command: Command) =>
      run(command, async (ctx) => {
        await update(ctx, { ...(name === undefined ? {} : { name }), ...options });
      }),
    );
  program
    .command('stamp')
    .description(
      'Refresh the .shared-stamp files that trigger releases when bundled shared code changes',
    )
    .option('--write', 'Rewrite stale stamps and print the components that changed')
    .option('--check', 'Write nothing; exit 1 when a stamp is stale')
    .action((options: { write?: boolean; check?: boolean }, command: Command) =>
      run(command, (ctx) => stamp(ctx, options)),
    );
  program
    .command('verify')
    .description('Run the done gate: lint, unit, drift, contract, e2e and units')
    .argument('[tool]', 'Tool name')
    .option('--all', 'Verify every tool in tools/')
    .action((tool: string | undefined, options: { all?: boolean }, command: Command) =>
      run(command, (ctx) => verify(ctx, tool, options)),
    );
  program
    .command('uninstall')
    .description('Remove an installed tool, its link and its record')
    .argument('<name>', 'Tool name')
    .action((name: string, _options: unknown, command: Command) =>
      run(command, (ctx) => uninstall(ctx, name)),
    );
}

function buildProgram(env: TbxEnv, streams: OutputStreams): Command {
  const program = new Command('tbx')
    .description('Scaffold, document and inspect the tools in this repo')
    .option('-y, --no-input', 'Disable all prompts')
    .option('--json', 'Print machine-readable JSON to stdout')
    .version(version.trim(), '-V, --version')
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
  const run: Runner = (command, body) => {
    const json = command.optsWithGlobals<GlobalFlags>().json === true;
    const out = createOutput({ json, streams });
    return body({ ...contextBase(env), json, out });
  };
  program
    .command('list')
    .description('List every tool in tools/ with its installed version')
    .action((_options: unknown, command: Command) => run(command, list));
  program
    .command('gen')
    .description('Regenerate READMEs, completions and docs; --check lists drift instead')
    .option('--check', 'Write nothing; exit 1 when a generated file is out of date')
    .option(
      '--strict',
      'Fail (exit 78) on a PATH-binary collision instead of warning; implied by CI=1',
    )
    .action((options: { check?: boolean; strict?: boolean }, command: Command) =>
      run(command, (ctx) =>
        gen(ctx, { check: options.check === true, strict: options.strict === true }),
      ),
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
  addReleaseCommands(program, run);
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
  return reportError(error, createOutput({ json: false, streams }));
}

const SIGNAL_EXIT_BASE = 128;

async function installedLink(argv: readonly string[], env: TbxEnv): Promise<string | null> {
  const [first] = argv;
  if (first === undefined || first.startsWith('-')) return null;
  if (RESERVED_COMMANDS.has(first)) return null;
  const variables = env.vars ?? process.env;
  const paths = tbxPaths(homeOf(variables), variables);
  const tool = await installedToolFor(paths, first);
  return tool === null ? null : path.join(paths.bin, tool);
}

function dispatch(link: string, args: readonly string[], streams: OutputStreams): number {
  const child = spawnSync(link, args, { stdio: 'inherit' });
  if (child.error !== undefined) {
    streams.stderr(
      `error: cannot run ${link}: ${child.error.message}; reinstall it with tbx install\n`,
    );
    return ExitCode.unavailable;
  }
  if (child.signal !== null) return SIGNAL_EXIT_BASE + constants.signals[child.signal];
  return child.status ?? ExitCode.failure;
}

async function execute(
  argv: readonly string[],
  env: TbxEnv,
  streams: OutputStreams,
): Promise<number> {
  try {
    const program = buildProgram(env, streams);
    const link = await installedLink(argv, env);
    if (link !== null) return dispatch(link, argv.slice(1), streams);
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.ok;
  } catch (error) {
    return exitCodeOf(error, streams);
  }
}

/**
 * Runs `tbx` with `argv` (no program name) against `env.root` and returns the exit code with
 * the captured stdout and stderr, instead of writing to the process streams or exiting. Usage
 * errors and unknown flags exit 2; a `ToolError` exits with its code; an invalid manifest
 * exits 78. A first argument that is not a command but names a tool in `installed.json`, or the
 * alias its installed `tool.toml` declares, runs that tool's managed-bin link with the remaining arguments and inherited stdio, returning its
 * exit code (128 plus the signal number when it is killed).
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

/**
 * True when the module at `moduleUrl` is the script being run: `argv1` (normally
 * `process.argv[1]`) resolves, through symlinks, to the module's file. Works on Bun and on Node
 * versions without `import.meta.main`.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = await execute(process.argv.slice(2), { root: REPO_ROOT }, PROCESS_STREAMS);
}

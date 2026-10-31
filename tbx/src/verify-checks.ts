import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareText } from '../../shared/ts/src/gen/files.ts';
import { findOnPath } from '../../shared/ts/src/paths.ts';
import { runOpen } from '../../shared/ts/src/run.ts';
import { withVariable } from './state.ts';
import type { Lang } from './templates.ts';

/** How one verify step ended; `detail` says why it failed or was skipped. */
export interface StepOutcome {
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}

/** A command a check runs, with its environment; `env` defaults to `process.env`. */
export interface CheckCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const CHECK_TIMEOUT_MS = 600_000;
const DETAIL_LINES = 40;
const TEST_FILES: Record<Lang, RegExp> = {
  ts: /\.test\.ts$/,
  py: /^(test_.*|.*_test)\.py$/,
  sh: /\.bats$/,
};
const SHELL_FILES = /\.(sh|bash)$/;

/** Last `DETAIL_LINES` lines of `text`, trimmed. */
export function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-DETAIL_LINES).join('\n');
}

/** A passing outcome when `failures` is empty, otherwise a failure listing them all. */
export function outcomeOf(failures: readonly string[]): StepOutcome {
  return failures.length === 0
    ? { status: 'pass' }
    : { status: 'fail', detail: failures.join('\n\n') };
}

/**
 * Runs each command from `root` in turn, all of them even after a failure, and returns one
 * failure text per command that exited non-zero, timed out or could not start: the command
 * line followed by the tail of its output.
 */
export async function runChecks(root: string, commands: CheckCommand[]): Promise<string[]> {
  const failures: string[] = [];
  for (const check of commands) {
    const failure = await runCheck(root, check);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

async function runCheck(
  root: string,
  { command, args, env }: CheckCommand,
): Promise<string | null> {
  const line = `$ ${[path.basename(command), ...args].join(' ')}`;
  try {
    const result = await runOpen(command, args, {
      cwd: root,
      timeoutMs: CHECK_TIMEOUT_MS,
      ...(env === undefined ? {} : { env }),
    });
    if (result.status === 0) return null;
    const why = result.timedOut ? 'timed out' : `exit ${String(result.status)}`;
    const output = tail([result.stdout, result.stderr].join('\n'));
    return `${line} (${why})\n${output}`;
  } catch (error) {
    return `${line}\ncannot run: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort(compareText);
  } catch {
    return [];
  }
}

/** Test files for `lang` under `<root>/tools/<name>/tests/<kind>`, as paths relative to `root`. */
export async function testFiles(
  root: string,
  name: string,
  lang: Lang,
  kind: 'unit' | 'e2e',
): Promise<string[]> {
  const files = await filesUnder(path.join(root, 'tools', name, 'tests', kind), TEST_FILES[lang]);
  return files.map((file) => path.relative(root, file));
}

function mypyEnv(root: string): NodeJS.ProcessEnv {
  return withVariable(process.env, 'MYPYPATH', path.join(root, 'shared/py'));
}

function nodeBin(root: string, name: string): string {
  return path.join(root, 'node_modules/.bin', name);
}

async function scopedTsconfig(root: string, dir: string, work: string): Promise<string> {
  const file = path.join(work, 'tsconfig.json');
  const config = {
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { typeRoots: [path.join(root, 'node_modules/@types')] },
    include: [`${dir}/src`, `${dir}/tests`, path.join(root, 'shared/ts/src/*.d.ts')],
  };
  await writeFile(file, JSON.stringify(config));
  return file;
}

async function shellFiles(root: string, name: string): Promise<string[]> {
  const dir = path.join(root, 'tools', name);
  const scripts = await filesUnder(dir, SHELL_FILES);
  return [path.join(dir, 'src', name), ...scripts].map((file) => path.relative(root, file));
}

/**
 * Runs the linters for a tool's language on `tools/<name>` only, with the repo's own configs
 * and the flags the justfile uses: biome, eslint and tsc (a temp tsconfig extending the root
 * one, including only the tool and the shared type declarations) for TypeScript; ruff check,
 * ruff format and mypy --strict for Python; shellcheck and shfmt -d on the tool's entry
 * script and any `.sh`/`.bash` files for shell.
 */
export async function lintStep(root: string, name: string, lang: Lang): Promise<StepOutcome> {
  const dir = `tools/${name}`;
  if (lang === 'py') {
    return outcomeOf(
      await runChecks(root, [
        { command: 'uv', args: ['run', 'ruff', 'check', dir] },
        { command: 'uv', args: ['run', 'ruff', 'format', '--check', dir] },
        { command: 'uv', args: ['run', 'mypy', '--strict', dir], env: mypyEnv(root) },
      ]),
    );
  }
  if (lang === 'sh') {
    const files = await shellFiles(root, name);
    return outcomeOf(
      await runChecks(root, [
        { command: 'shellcheck', args: files },
        { command: 'shfmt', args: ['-d', ...files] },
      ]),
    );
  }
  const work = await mkdtemp(path.join(tmpdir(), 'tbx-verify-tsc-'));
  try {
    const tsconfig = await scopedTsconfig(root, path.join(root, dir), work);
    return outcomeOf(
      await runChecks(root, [
        { command: nodeBin(root, 'biome'), args: ['ci', '--colors=off', dir] },
        { command: nodeBin(root, 'eslint'), args: ['--max-warnings=0', dir] },
        { command: nodeBin(root, 'tsc'), args: ['--noEmit', '-p', tsconfig] },
      ]),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The command that runs the test files of one kind (`tests/unit` or `tests/e2e`) of a tool:
 * vitest, pytest (`-p no:faulthandler --no-header -q`) or bats. With `env`, the runner is given
 * by absolute path (pytest through the root's virtualenv Python), so it needs nothing from
 * `env.PATH` beyond what the isolated environment links.
 */
export async function testCommand(
  root: string,
  lang: Lang,
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<CheckCommand> {
  const scoped = env === undefined ? {} : { env };
  if (lang === 'ts')
    return { command: nodeBin(root, 'vitest'), args: ['run', `${dir}/`], ...scoped };
  if (lang === 'sh') {
    const bats = env === undefined ? 'bats' : await findOnPath('bats', process.env.PATH ?? '');
    return { command: bats ?? 'bats', args: ['-r', dir], ...scoped };
  }
  const pytest = ['-p', 'no:faulthandler', '--no-header', '-q', dir];
  if (env === undefined) return { command: 'uv', args: ['run', 'pytest', ...pytest] };
  return { command: await venvPython(root), args: ['-m', 'pytest', ...pytest], env };
}

async function venvPython(root: string): Promise<string> {
  const result = await runOpen('uv', ['run', 'python', '-c', 'import sys; print(sys.executable)'], {
    cwd: root,
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  return result.stdout.trim() || 'python3';
}

/** Runs `tests/unit` of a tool with its language's runner; no unit test file is a failure. */
export async function unitStep(root: string, name: string, lang: Lang): Promise<StepOutcome> {
  const dir = `tools/${name}/tests/unit`;
  const files = await testFiles(root, name, lang, 'unit');
  if (files.length === 0) {
    return { status: 'fail', detail: `no unit tests in ${dir}` };
  }
  return outcomeOf(await runChecks(root, [await testCommand(root, lang, dir)]));
}

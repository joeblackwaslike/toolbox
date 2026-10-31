import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { messageOf } from '../../shared/ts/src/errors.ts';
import {
  CONTRACT_PLACEHOLDER,
  type ContractCase,
  generateContractTests,
} from '../../shared/ts/src/gen/contract.ts';
import { checkDrift } from '../../shared/ts/src/gen/index.ts';
import { validateUnit } from '../../shared/ts/src/gen/unit.ts';
import type { ToolManifest } from '../../shared/ts/src/manifest.ts';
import { runInPty } from '../../shared/ts/src/pty.ts';
import { type RunResult, runOpen } from '../../shared/ts/src/run.ts';
import type { IsolatedEnv } from './isolated-env.ts';
import { unitFiles } from './stage.ts';
import { withVariable } from './state.ts';
import {
  type StepOutcome,
  outcomeOf,
  runChecks,
  tail,
  testCommand,
  testFiles,
} from './verify-checks.ts';

/** The candidate installed into an isolated environment, at its managed-bin link. */
export interface Installed {
  link: string;
  isolated: IsolatedEnv;
}

/** Bytes typed into the interactive run: one Ctrl-D, so a prompt reads end of input. */
const INTERACTIVE_INPUT = '\u0004';
const MS_PER_SECOND = 1000;
const SIGNAL_EXIT_BASE = 128;
/** Shell exit codes for a command that was found but not executable (126) or not found (127). */
const CANNOT_EXECUTE = 126;
const NOT_FOUND = 127;
const NOT_RUNNABLE: ReadonlySet<number> = new Set([CANNOT_EXECUTE, NOT_FOUND]);

function runInstalled(
  installed: Installed,
  argv: string[],
  timeoutMs?: number,
): ReturnType<typeof runOpen> {
  const { env, home } = installed.isolated;
  return runOpen(installed.link, argv, {
    env,
    cwd: home,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function interfaceFailure(m: ToolManifest, installed: Installed): Promise<string | null> {
  const help = await runInstalled(installed, ['--help', '--json']);
  let printed: unknown;
  try {
    printed = JSON.parse(help.stdout);
  } catch {
    return `--help --json printed no JSON (exit ${String(help.status)}): ${tail(help.stderr)}`;
  }
  if (isDeepStrictEqual(printed, usageOf(m))) return null;
  return `--help --json differs from tool.toml:\n  printed  ${JSON.stringify(printed)}\n  expected ${JSON.stringify(usageOf(m))}`;
}

/**
 * Drift: the tool's generated files (`tools/<name>/...` entries of `checkDrift`) must match
 * `tbx gen`, and the installed tool's `--help --json` must deep-equal `usageOf(m)`. `installed`
 * is the candidate, a string saying why it could not be built or installed (a failure, since
 * the interface cannot be checked), or `null` when this platform does not run the tool.
 */
export async function driftStep(
  root: string,
  m: ToolManifest,
  installed: Installed | string | null,
): Promise<StepOutcome> {
  const prefix = `tools/${m.name}/`;
  const report = await checkDrift(root);
  const drifted = report.filter((file) => file.startsWith(prefix));
  const failures = drifted.length === 0 ? [] : [`differs from \`tbx gen\`: ${drifted.join(', ')}`];
  if (typeof installed === 'string') {
    failures.push(`interface check needs the built tool: ${installed}`);
  } else if (installed !== null) {
    const failure = await interfaceFailure(m, installed);
    if (failure !== null) failures.push(failure);
  }
  return outcomeOf(failures);
}

/**
 * Contract: every `generateContractTests(m)` case run against the installed binary must exit
 * as expected, print nothing to stdout when it fails, and print one JSON document when the
 * case expects JSON.
 */
export async function contractStep(m: ToolManifest, installed: Installed): Promise<StepOutcome> {
  const failures: string[] = [];
  for (const c of generateContractTests(m)) {
    failures.push(...caseFailures(c, await runInstalled(installed, c.argv)));
  }
  return outcomeOf(failures);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function caseFailures(c: ContractCase, result: RunResult): string[] {
  const label = `${c.name} (${c.argv.join(' ')})`;
  if (result.timedOut) return [`${label}: did not exit`];
  const failures: string[] = [];
  if (result.status !== c.expectExit) {
    const stderr = result.stderr.trim().split('\n')[0] ?? '';
    failures.push(`${label}: exit ${String(result.status)}, expected ${c.expectExit}: ${stderr}`);
  }
  if (c.expectExit !== 0 && result.stdout !== '') failures.push(`${label}: wrote to stdout`);
  if (c.expectStdout === 'json' && !isJson(result.stdout)) {
    failures.push(`${label}: stdout is not one JSON document`);
  }
  return failures;
}

async function nonInteractiveFailure(
  argv: string[],
  installed: Installed,
  deadlineMs: number,
): Promise<string | null> {
  const result = await runInstalled(installed, [...argv, '-y', '--json'], deadlineMs);
  const label = `non-interactive run (${[...argv, '-y', '--json'].join(' ')})`;
  if (result.timedOut) return `${label} killed at the ${deadlineMs / MS_PER_SECOND}s deadline`;
  if (result.status === 0) {
    return isJson(result.stdout) ? null : `${label}: stdout is not one JSON document`;
  }
  return result.stdout === '' ? null : `${label}: exit ${String(result.status)} with stdout output`;
}

async function interactiveFailure(
  argv: string[],
  installed: Installed,
  deadlineMs: number,
): Promise<string | null> {
  const { env, home } = installed.isolated;
  const label = `interactive run (${argv.join(' ') || 'no arguments'})`;
  try {
    const result = await runInPty([installed.link, ...argv], {
      env,
      cwd: home,
      input: INTERACTIVE_INPUT,
      deadlineMs,
    });
    if (!result.started) return `${label}: cannot start a pty:\n${tail(result.output)}`;
    if (result.timedOut) {
      return `${label} killed at the ${deadlineMs / MS_PER_SECOND}s deadline:\n${tail(result.output)}`;
    }
    if (result.code !== null && NOT_RUNNABLE.has(result.code)) {
      return `${label} could not run the tool (exit ${result.code}):\n${tail(result.output)}`;
    }
    const signalled = result.code === null || result.code > SIGNAL_EXIT_BASE;
    return signalled ? `${label} ended by a signal (exit ${String(result.code)})` : null;
  } catch (error) {
    return `${label}: cannot start a pty: ${messageOf(error)}`;
  }
}

/**
 * End to end against the installed binary in the isolated environment: a non-interactive run
 * (`<required placeholders> -y --json` on a non-TTY stdin) must exit before `deadlineMs` with
 * JSON on stdout, or nothing on stdout when it fails; an interactive run (the placeholders, no
 * flags, in a pty, stdin given one Ctrl-D) must start its pty, then exit before `deadlineMs`,
 * not by a signal and not with 126 or 127 (the tool could not be executed);
 * then the tool's own `tests/e2e`, when it has any, must pass, run with `TBX_TOOL_BIN` set to
 * the installed binary and the managed bin directory first on `PATH`.
 */
export async function endToEndStep(
  root: string,
  m: ToolManifest,
  installed: Installed,
  deadlineMs: number,
): Promise<StepOutcome> {
  const argv = m.args.filter((argument) => argument.required).map(() => CONTRACT_PLACEHOLDER);
  const failures: string[] = [];
  for (const failure of [
    await nonInteractiveFailure(argv, installed, deadlineMs),
    await interactiveFailure(argv, installed, deadlineMs),
  ]) {
    if (failure !== null) failures.push(failure);
  }
  const suite = await testFiles(root, m.name, m.language, 'e2e');
  if (suite.length > 0) {
    const { env } = installed.isolated;
    const binFirst = [path.dirname(installed.link), env.PATH ?? ''].join(path.delimiter);
    const suiteEnv = withVariable(
      withVariable(env, 'PATH', binFirst),
      'TBX_TOOL_BIN',
      installed.link,
    );
    const command = await testCommand(root, m.language, suite, suiteEnv);
    failures.push(...(await runChecks(root, [command])));
  }
  return outcomeOf(failures);
}

/**
 * Units: renders the tool's unit files for this platform with the isolated install paths and
 * validates each launchd plist or systemd service. A tool without `[unit]` is skipped ("no
 * unit"); a missing validator is skipped with a warning, or fails when `ci` is true.
 */
export async function unitsStep(
  m: ToolManifest,
  link: string,
  home: string,
  ci: boolean,
): Promise<StepOutcome> {
  if (m.unit === undefined) return { status: 'skipped', detail: 'no unit' };
  const { failures, skipped } = await validateAll(unitFiles(m, link, home));
  if (failures.length > 0 || skipped.length === 0) return outcomeOf(failures);
  return ci
    ? { status: 'fail', detail: `validator missing under CI: ${skipped.join('; ')}` }
    : { status: 'skipped', detail: `warning: unit not validated: ${skipped.join('; ')}` };
}

async function validateAll(
  files: [string, string][],
): Promise<{ failures: string[]; skipped: string[] }> {
  const failures: string[] = [];
  const skipped: string[] = [];
  for (const [file, content] of files.filter(([name]) => !name.endsWith('.timer'))) {
    const result = await validateUnit(file.endsWith('.plist') ? 'launchd' : 'systemd', content);
    if (!result.ok) failures.push(`${file}: ${result.message}`);
    else if (result.skipped) skipped.push(`${file}: ${result.message}`);
  }
  return { failures, skipped };
}

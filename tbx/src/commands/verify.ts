import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import type { ToolManifest } from '../../../shared/ts/src/manifest.ts';
import { tbxBinDir } from '../../../shared/ts/src/paths.ts';
import type { TbxContext } from '../context.ts';
import { type IsolatedEnv, createIsolatedEnv } from '../isolated-env.ts';
import { CURRENT_PLATFORM } from '../stage.ts';
import { type StepOutcome, lintStep, unitStep, unitTestEnv } from '../verify-checks.ts';
import {
  type Installed,
  contractStep,
  driftStep,
  endToEndStep,
  unitsStep,
} from '../verify-steps.ts';
import { buildTool, writeIndex } from './build.ts';
import { installTool } from './install.ts';

/** The steps of `tbx verify`, in the order they run. */
export const VERIFY_STEPS = ['lint', 'unit', 'drift', 'contract', 'e2e', 'units'] as const;
/** One of `VERIFY_STEPS`. */
export type VerifyStepName = (typeof VERIFY_STEPS)[number];

/** What `verifyTool` found: every step with its outcome, and `ok` when none failed. */
export interface VerifyReport {
  steps: ({ name: VerifyStepName } & StepOutcome)[];
  ok: boolean;
}

/** Options for `verifyTool`. */
export interface VerifyOptions {
  /** Fail instead of skip when a unit validator is missing; defaults to `CI` being `1`/`true`. */
  ci?: boolean;
  /** Deadline for each interactive and non-interactive e2e run; defaults to 30 seconds. */
  ptyDeadlineMs?: number;
}

const PTY_DEADLINE_MS = 30_000;
const STATUS_WIDTH = 8;
const CI_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

function discard(): void {
  /* The units step reports a skipped validator itself. */
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildAndInstall(
  root: string,
  m: ToolManifest,
  isolated: IsolatedEnv,
): Promise<Installed | string> {
  const out = await mkdtemp(path.join(tmpdir(), 'tbx-verify-build-'));
  try {
    let index: string;
    try {
      const built = await buildTool(root, m.name, out);
      const artifact = path.basename(built.artifact);
      index = await writeIndex(out, [
        { name: m.name, version: built.version, artifact, sha256: built.sha256 },
      ]);
    } catch (error) {
      return `build failed: ${messageOf(error)}`;
    }
    try {
      await installTool({
        name: m.name,
        index,
        home: isolated.home,
        env: isolated.env,
        warn: discard,
      });
    } catch (error) {
      return `install failed: ${messageOf(error)}`;
    }
    return { link: path.join(tbxBinDir(isolated.env), m.name), isolated };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function manifestOf(root: string, name: string): Promise<ToolManifest> {
  const manifests = await loadToolManifests(root);
  const m = manifests.find((tool) => tool.name === name);
  if (m === undefined) throw new ToolError(`unknown tool "${name}"`, ExitCode.usage);
  return m;
}

async function isolatedUnitStep(root: string, m: ToolManifest): Promise<StepOutcome> {
  const isolated = await createIsolatedEnv();
  try {
    return await unitStep(root, m.name, m.language, await unitTestEnv(isolated.env));
  } finally {
    await isolated.cleanup();
  }
}

function skipped(detail: string): StepOutcome {
  return { status: 'skipped', detail };
}

async function againstCandidate(
  root: string,
  m: ToolManifest,
  options: VerifyOptions,
  isolated: IsolatedEnv,
): Promise<StepOutcome[]> {
  const elsewhere = skipped(`${m.name} does not run on ${CURRENT_PLATFORM}`);
  const link = path.join(tbxBinDir(isolated.env), m.name);
  const ci = options.ci ?? CI_VALUES.has(process.env.CI ?? '');
  if (!m.platforms.includes(CURRENT_PLATFORM)) {
    const units = m.unit === undefined ? skipped('no unit') : elsewhere;
    return [await driftStep(root, m, null), elsewhere, elsewhere, units];
  }
  const installed = await buildAndInstall(root, m, isolated);
  if (typeof installed === 'string') {
    const unbuilt = skipped(installed.startsWith('build') ? 'build failed' : 'install failed');
    return [
      await driftStep(root, m, installed),
      unbuilt,
      unbuilt,
      await unitsStep(m, link, isolated.home, ci),
    ];
  }
  return [
    await driftStep(root, m, installed),
    await contractStep(m, installed),
    await endToEndStep(root, m, installed, options.ptyDeadlineMs ?? PTY_DEADLINE_MS),
    await unitsStep(m, link, isolated.home, ci),
  ];
}

/**
 * Runs the done gate for `tools/<name>` under `root`, every step even after a failure: lint in
 * the host environment, unit tests in the host environment with HOME and the XDG directories
 * moved into their own `createIsolatedEnv()` tree (see `unitTestEnv`), then a build of the checkout into a temp release index,
 * installed into a fresh `createIsolatedEnv()`, against which drift (generated files and the
 * `--help --json` interface), contract, e2e and units run. Contract and e2e are skipped when
 * the build or install fails (drift then fails, since the interface cannot be checked); unit
 * tests, contract, e2e and units are skipped when the tool does not run on this platform.
 * `ok` is true when no step failed. The isolated environment is always removed.
 *
 * @throws {ToolError} exit 2 when `tools/<name>/tool.toml` does not exist.
 */
export async function verifyTool(
  root: string,
  name: string,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const m = await manifestOf(root, name);
  const supported = m.platforms.includes(CURRENT_PLATFORM);
  const lint = await lintStep(root, name, m.language);
  const unit = supported
    ? await isolatedUnitStep(root, m)
    : skipped(`${name} does not run on ${CURRENT_PLATFORM}`);
  const isolated = await createIsolatedEnv();
  let rest: StepOutcome[];
  try {
    rest = await againstCandidate(root, m, options, isolated);
  } finally {
    await isolated.cleanup();
  }
  const outcomes = [lint, unit, ...rest];
  const steps = VERIFY_STEPS.map((stepName, index) => ({
    name: stepName,
    ...(outcomes[index] ?? skipped('not run')),
  }));
  return { steps, ok: steps.every((step) => step.status !== 'fail') };
}

function humanReport(name: string, report: VerifyReport): string {
  const lines = [`${name}: ${report.ok ? 'ok' : 'FAILED'}`];
  for (const step of report.steps) {
    const line = `  ${step.status.padEnd(STATUS_WIDTH)}${step.name}`;
    if (step.detail === undefined) lines.push(line);
    else if (step.status === 'fail') {
      lines.push(line, ...step.detail.split('\n').map((text) => `    ${text}`));
    } else lines.push(`${line} (${step.detail})`);
  }
  return lines.join('\n');
}

async function targets(ctx: TbxContext, name: string | undefined, all: boolean): Promise<string[]> {
  if ((name === undefined) === !all) {
    throw new ToolError('give one tool name or --all', ExitCode.usage);
  }
  if (all) {
    const manifests = await loadToolManifests(ctx.root);
    return manifests.map((m) => m.name);
  }
  await manifestOf(ctx.root, name ?? '');
  return [name ?? ''];
}

/**
 * `tbx verify <tool>` or `tbx verify --all`: runs `verifyTool` for each tool and prints one
 * line per step (with the detail of failed and skipped steps), or with `--json` the report
 * (`{name, steps, ok}` for one tool, `{ok, tools}` for `--all`). Exits 1 when any step failed
 * and 2 for an unknown tool or a missing target; `--all` with no tools succeeds.
 */
export async function verify(
  ctx: TbxContext,
  name: string | undefined,
  options: { all?: boolean },
): Promise<void> {
  const all = options.all === true;
  const names = await targets(ctx, name, all);
  if (names.length === 0) {
    ctx.out.result(ctx.json ? { ok: true, tools: [] } : 'no tools to verify');
    return;
  }
  const reports: ({ name: string } & VerifyReport)[] = [];
  for (const tool of names) {
    ctx.out.info(`verifying ${tool}`);
    reports.push({ name: tool, ...(await verifyTool(ctx.root, tool, { ci: ctx.ci })) });
  }
  const ok = reports.every((report) => report.ok);
  if (ctx.json) ctx.out.result(all ? { ok, tools: reports } : reports[0]);
  else ctx.out.result(reports.map((report) => humanReport(report.name, report)).join('\n\n'));
  if (!ok) {
    const failed = reports.filter((report) => !report.ok).map((report) => report.name);
    throw new ToolError(`verify failed: ${failed.join(', ')}`);
  }
}

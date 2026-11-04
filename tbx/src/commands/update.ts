import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import type { TbxContext } from '../context.ts';
import { fetchIndex } from '../remote.ts';
import { assertToolName, readState, tbxPaths } from '../state.ts';
import type { IndexEntry } from './build.ts';
import { defaultIndex, installTool, resolveIndex } from './install.ts';

/** Outcome for one tool; `to` is null when it was already current. */
export interface UpdateResult {
  name: string;
  from: string;
  to: string | null;
}

/** Options for `update`. */
export interface UpdateOptions {
  /** Tool to update; every installed tool when omitted. */
  name?: string;
  /** Release `index.json` path or URL; defaults like `tbx install`. */
  index?: string;
}

const CORE_PARTS = 3;
const NUMERIC_IDENTIFIER = /^\d+$/;

/** Strips SemVer build metadata (`+...`), then splits the core from dot-separated prerelease identifiers. */
function parse(version: string): { core: number[]; pre: string[] } {
  const [core = '', ...rest] = version.split('+')[0]?.split('-') ?? [];
  const pre = rest.join('-');
  return { core: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') };
}

function compareCore(a: number[], b: number[]): number {
  for (let part = 0; part < CORE_PARTS; part += 1) {
    const diff = (a[part] ?? 0) - (b[part] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** SemVer precedence for one pair of dot-separated prerelease identifiers. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence for two prerelease identifier lists; no prerelease sorts above any prerelease. */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Number(a.length === 0) - Number(b.length === 0);
  const shared = Math.min(a.length, b.length);
  for (let part = 0; part < shared; part += 1) {
    const diff = compareIdentifier(a[part] ?? '', b[part] ?? '');
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** True when `candidate` is strictly newer than `current`; a pre-release sorts below its release. */
function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  const core = compareCore(a.core, b.core);
  if (core !== 0) return core > 0;
  return comparePre(a.pre, b.pre) > 0;
}

function assertInstalled(name: string, installed: Record<string, unknown>): void {
  assertToolName(name);
  if (!Object.hasOwn(installed, name)) {
    throw new ToolError(`${name} is not installed`, ExitCode.config);
  }
}

function describe(result: UpdateResult): string {
  return result.to === null
    ? `${result.name} ${result.from} is current`
    : `${result.name} ${result.from} -> ${result.to}`;
}

async function updateOne(
  ctx: TbxContext,
  index: string,
  entries: IndexEntry[],
  name: string,
  from: string,
): Promise<UpdateResult> {
  const latest = entries.find((tool) => tool.name === name)?.version;
  if (latest === undefined || !isNewer(latest, from)) return { name, from, to: null };
  await installTool({
    name,
    index,
    home: ctx.home,
    env: ctx.env,
    warn: (message) => {
      ctx.out.info(message);
    },
  });
  return { name, from, to: latest };
}

/**
 * `tbx update [name] [--index <path|url>]`: installs the index version of each installed tool
 * that is newer than the recorded one. Never downgrades.
 *
 * @throws {ToolError} with `ExitCode.config` when `name` is not installed.
 */
export async function update(ctx: TbxContext, options: UpdateOptions): Promise<UpdateResult[]> {
  const state = await readState(tbxPaths(ctx.home, ctx.env));
  if (options.name !== undefined) assertInstalled(options.name, state.tools);
  const index = resolveIndex(options.index ?? defaultIndex(ctx.env));
  const entries = await fetchIndex(index);
  const results: UpdateResult[] = [];
  for (const [name, record] of Object.entries(state.tools)) {
    if (options.name !== undefined && options.name !== name) continue;
    results.push(await updateOne(ctx, index, entries, name, record.version));
  }
  const text = results.map((result) => describe(result)).join('\n');
  ctx.out.result(ctx.json ? { updated: results } : text || 'no tools installed');
  return results;
}

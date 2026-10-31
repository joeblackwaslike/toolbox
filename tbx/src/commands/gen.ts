import { ToolError } from '../../../shared/ts/src/errors.ts';
import {
  checkDrift,
  loadToolManifests,
  syncGenerated,
  undocumentedSymbols,
} from '../../../shared/ts/src/gen/index.ts';
import { assertNoCollisions } from '../../../shared/ts/src/manifest.ts';
import { binariesOnPath } from '../../../shared/ts/src/paths.ts';
import type { TbxContext } from '../context.ts';

function printLines(ctx: TbxContext, json: unknown, lines: string[]): void {
  if (ctx.json) ctx.out.result(json);
  else if (lines.length > 0) ctx.out.result(lines.join('\n'));
}

/**
 * Regenerates every README, completion, catalog and shared doc page, deleting stale ones; with
 * `check`, writes nothing and lists drifted files instead, exiting 1 when any drifted. Both
 * modes first refuse a tool name or alias that collides with another tool or a PATH binary
 * (exit 78), and fail on public shared symbols without a doc comment.
 */
export async function gen(ctx: TbxContext, options: { check: boolean }): Promise<void> {
  assertNoCollisions(await loadToolManifests(ctx.root), await binariesOnPath(ctx.path));
  if (options.check) {
    const drift = await checkDrift(ctx.root);
    printLines(
      ctx,
      drift,
      drift.map((entry) => `drift: ${entry}`),
    );
    if (drift.length > 0) {
      throw new ToolError(`${drift.length} generated file(s) out of date; run \`tbx gen\``);
    }
    return;
  }
  const deleted = await syncGenerated(ctx.root);
  const undocumented = await undocumentedSymbols(ctx.root);
  printLines(ctx, { deleted, undocumented }, [
    ...deleted.map((file) => `deleted: ${file}`),
    ...undocumented,
  ]);
  if (undocumented.length > 0) {
    throw new ToolError(`${undocumented.length} public shared symbol(s) have no doc comment`);
  }
}

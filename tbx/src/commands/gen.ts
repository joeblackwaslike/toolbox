import { ToolError } from '../../../shared/ts/src/errors.ts';
import {
  checkDrift,
  loadToolManifests,
  syncGenerated,
  undocumentedSymbols,
} from '../../../shared/ts/src/gen/index.ts';
import {
  ManifestError,
  assertNoCollisions,
  describePathCollision,
  findPathCollisions,
} from '../../../shared/ts/src/manifest.ts';
import type { TbxContext } from '../context.ts';

function printLines(ctx: TbxContext, json: unknown, lines: string[]): void {
  if (ctx.json) ctx.out.result(json);
  else if (lines.length > 0) ctx.out.result(lines.join('\n'));
}

async function checkCollisions(ctx: TbxContext, strict: boolean): Promise<void> {
  const manifests = await loadToolManifests(ctx.root);
  assertNoCollisions(manifests, []);
  const collisions = findPathCollisions(manifests, await ctx.pathBinaries());
  const [first] = collisions;
  if (first !== undefined && (strict || ctx.ci)) {
    throw new ManifestError(describePathCollision(first), first.identifier);
  }
  for (const collision of collisions) ctx.out.info(`warning: ${describePathCollision(collision)}`);
}

/**
 * Regenerates every README, completion, catalog and shared doc page, deleting stale ones; with
 * `check`, writes nothing and lists drifted files instead, exiting 1 when any drifted. Both
 * modes first refuse (exit 78) two tools sharing a name or alias. A name or alias that
 * shadows a PATH executable prints a warning, or fails with exit 78 under `strict` or `CI`.
 * Undocumented public shared symbols fail the run.
 */
export async function gen(
  ctx: TbxContext,
  options: { check: boolean; strict: boolean },
): Promise<void> {
  await checkCollisions(ctx, options.strict);
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

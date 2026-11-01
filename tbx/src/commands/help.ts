import { usageOf } from '../../../shared/ts/src/cli.ts';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import type { ToolManifest } from '../../../shared/ts/src/manifest.ts';
import type { TbxContext } from '../context.ts';

const MAX_DISTANCE = 2;

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a.charAt(row - 1) === b.charAt(column - 1) ? 0 : 1;
      current.push(
        Math.min(
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
          (previous[column - 1] ?? 0) + cost,
        ),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function unknownTool(tool: string, manifests: ToolManifest[]): ToolError {
  const names = manifests.flatMap((m) => (m.alias === undefined ? [m.name] : [m.name, m.alias]));
  const close = names.filter(
    (name) => name.startsWith(tool) || distance(name, tool) <= MAX_DISTANCE,
  );
  const hint =
    close.length > 0 ? `did you mean ${close.join(', ')}?` : 'run `tbx list` to see every tool';
  return new ToolError(`unknown tool "${tool}"; ${hint}`, ExitCode.usage);
}

/**
 * Prints `usageOf` the tool whose name or alias is `tool`. An unknown tool exits 2 with a
 * message naming close matches.
 */
export async function help(ctx: TbxContext, tool: string): Promise<void> {
  const manifests = await loadToolManifests(ctx.root);
  const manifest = manifests.find((m) => m.name === tool || m.alias === tool);
  if (manifest === undefined) throw unknownTool(tool, manifests);
  ctx.out.result(usageOf(manifest));
}

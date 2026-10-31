import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import type { TbxContext } from '../context.ts';

const HEADER = ['name', 'version', 'language', 'platforms', 'summary'];
const GAP = 2;

function table(rows: string[][]): string {
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + GAP),
        )
        .join(''),
    )
    .join('\n');
}

/**
 * Prints every tool under `tools/`: a table of name, version, language, platforms and
 * summary, or the array of manifests with `--json`.
 */
export async function list(ctx: TbxContext): Promise<void> {
  const manifests = await loadToolManifests(ctx.root);
  if (ctx.json) {
    ctx.out.result(manifests);
    return;
  }
  if (manifests.length === 0) {
    ctx.out.info('no tools under tools/');
    return;
  }
  const rows = manifests.map((m) => [
    m.name,
    m.version,
    m.language,
    m.platforms.join(','),
    m.summary,
  ]);
  ctx.out.result(table([HEADER, ...rows]));
}

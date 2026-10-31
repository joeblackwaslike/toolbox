import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import type { TbxContext } from '../context.ts';
import { readState, recordOf, tbxPaths } from '../state.ts';

const HEADER = ['name', 'version', 'installed', 'language', 'platforms', 'summary'];
const NOT_INSTALLED = '-';
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
 * Prints every tool under `tools/` with the version installed from `installed.json`: a table of
 * name, version, installed (`-` when not installed), language, platforms and summary, or with
 * `--json` the array of manifests, each with `installed: string | null`.
 */
export async function list(ctx: TbxContext): Promise<void> {
  const state = await readState(tbxPaths(ctx.home, ctx.env));
  const loaded = await loadToolManifests(ctx.root);
  const manifests = loaded.map((m) => ({
    ...m,
    installed: recordOf(state, m.name)?.version ?? null,
  }));
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
    m.installed ?? NOT_INSTALLED,
    m.language,
    m.platforms.join(','),
    m.summary,
  ]);
  ctx.out.result(table([HEADER, ...rows]));
}

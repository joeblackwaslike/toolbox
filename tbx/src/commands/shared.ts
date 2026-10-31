import { syncGenerated } from '../../../shared/ts/src/gen/index.ts';
import { extractSharedDocs } from '../../../shared/ts/src/gen/shared-docs.ts';
import type { TbxContext } from '../context.ts';
import { type Lang, renderTemplates, templateVariables, writeNewFiles } from '../templates.ts';

/** One `tbx shared search` hit: a public shared symbol and the first line of its doc. */
export interface SharedHit {
  lang: Lang;
  module: string;
  symbol: string;
  signature: string;
  summary: string;
}

/**
 * Prints the public shared symbols whose name or doc comment contains `term`, ignoring case:
 * one `<lang>/<module>.<symbol>` line with its signature and first doc line each, or an array
 * of `SharedHit` with `--json`. No match is not an error.
 */
export async function searchShared(ctx: TbxContext, term: string): Promise<void> {
  const needle = term.toLowerCase();
  const mods = await extractSharedDocs(ctx.root);
  const hits: SharedHit[] = mods.flatMap((mod) =>
    mod.symbols
      .filter((s) => `${s.name}\n${s.doc}`.toLowerCase().includes(needle))
      .map((s) => ({
        lang: mod.lang,
        module: mod.module,
        symbol: s.name,
        signature: s.signature,
        summary: s.doc.split('\n')[0] ?? '',
      })),
  );
  if (ctx.json) {
    ctx.out.result(hits);
  } else if (hits.length === 0) {
    ctx.out.info(`no shared symbol mentions "${term}"`);
  } else {
    const lines = hits.map(
      (hit) => `${hit.lang}/${hit.module}.${hit.symbol}  ${hit.signature}\n    ${hit.summary}`,
    );
    ctx.out.result(lines.join('\n'));
  }
}

/**
 * Scaffolds a shared module in `lang` from `tbx/templates/shared/<lang>`: a doc-commented
 * stub and one failing test, then regenerates the shared doc pages. Exits 2 for an invalid
 * name or when any of the module's files already exists.
 */
export async function newShared(ctx: TbxContext, name: string, lang: Lang): Promise<void> {
  const files = await renderTemplates(
    `shared/${lang}`,
    templateVariables(name, 'shared module name'),
  );
  await writeNewFiles(ctx.root, files);
  await syncGenerated(ctx.root);
  const paths = files.map((file) => file.path);
  ctx.out.result(ctx.json ? { name, lang, files: paths } : paths.join('\n'));
}

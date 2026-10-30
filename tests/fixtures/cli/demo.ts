import { fileURLToPath } from 'node:url';
import { defineTool } from '../../../shared/ts/src/cli.ts';
import { ExitCode, ToolError } from '../../../shared/ts/src/errors.ts';
import { loadManifest } from '../../../shared/ts/src/manifest.ts';

const manifest = await loadManifest(
  fileURLToPath(new URL('../tools/demo/tool.toml', import.meta.url)),
);

await defineTool(manifest, (ctx) => {
  if (ctx.args.src === 'fail') {
    return Promise.reject(new ToolError('failed on purpose', ExitCode.config));
  }
  ctx.out.result({ args: ctx.args, opts: ctx.opts, json: ctx.json, interactive: ctx.interactive });
  return Promise.resolve();
});

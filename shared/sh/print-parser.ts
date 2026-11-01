import { loadManifest } from '../ts/src/manifest.ts';
import { generateShellParser } from './gen-parser.ts';

const [manifestPath] = process.argv.slice(2);
if (manifestPath === undefined) {
  process.stderr.write('Usage: bun shared/sh/print-parser.ts <tool.toml>\n');
  process.exitCode = 2;
} else {
  process.stdout.write(generateShellParser(await loadManifest(manifestPath)));
}

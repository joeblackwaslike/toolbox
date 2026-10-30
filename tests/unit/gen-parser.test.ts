import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateShellParser } from '../../shared/sh/gen-parser.ts';
import { loadManifest, parseManifest } from '../../shared/ts/src/manifest.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

describe('generateShellParser', () => {
  it('matches the committed demo prelude', async () => {
    const manifest = await loadManifest(`${FIXTURES}tools/demo/tool.toml`);
    const committed = await readFile(`${FIXTURES}cli/demo-parser.sh`, 'utf8');
    expect(generateShellParser(manifest)).toBe(committed);
  });

  it('emits a prelude that passes shellcheck and shfmt for a manifest with quotes', () => {
    const prelude = generateShellParser(
      parseManifest(`
name = "q"
summary = "It's \\"quoted\\" and $HOME"
language = "sh"
version = "1.0.0"
platforms = ["linux"]
[[options]]
long = "dry-run"
summary = "Don't touch $PATH or \`x\`"
type = "bool"
default = true
`),
    );
    const check = spawnSync('shellcheck', ['-s', 'bash', '-'], {
      input: prelude,
      encoding: 'utf8',
    });
    expect(check.stdout).toBe('');
    expect(check.status).toBe(0);
    const format = spawnSync('shfmt', ['-i', '2', '-d'], { input: prelude, encoding: 'utf8' });
    expect(format.stdout).toBe('');
    expect(prelude).toContain('TBX_OPT_DRY_RUN=1');
  });
});

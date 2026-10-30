import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderCompletions } from '../../shared/ts/src/gen/completions.ts';
import {
  type GeneratedFile,
  checkDrift,
  generateAll,
  syncGenerated,
  writeGenerated,
} from '../../shared/ts/src/gen/index.ts';
import { renderCatalog, renderToolReadme } from '../../shared/ts/src/gen/readme.ts';
import {
  type SharedModuleDoc,
  extractSharedDocs,
  missingSharedDocs,
  renderSharedDocs,
} from '../../shared/ts/src/gen/shared-docs.ts';
import { loadManifest } from '../../shared/ts/src/manifest.ts';

const FIXTURES = join(import.meta.dirname, '../fixtures');
const DEMO = join(FIXTURES, 'tools/demo/tool.toml');

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tbx-gen-'));
  await cp(join(FIXTURES, 'tools'), join(root, 'tools'), { recursive: true });
  return root;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

const MODULES: SharedModuleDoc[] = [
  {
    lang: 'ts',
    module: 'a',
    symbols: [{ name: 'documented', signature: 'function documented(): void', doc: 'Does it.' }],
  },
  {
    lang: 'py',
    module: 'b',
    symbols: [{ name: 'bare', signature: 'def bare()', doc: '' }],
  },
];

describe('renderToolReadme', () => {
  it('readme lists every option with its short form', async () => {
    const readme = renderToolReadme(await loadManifest(DEMO));
    expect(readme).toContain('`-v, --verbose`');
    expect(readme).toContain('`-m, --mode <mode>`');
    expect(readme).toContain('`--count <count>`');
    expect(readme).toContain('`-y, --no-input`');
    expect(readme).toContain('demo [options] <src> [dest]');
    expect(readme.endsWith('\n')).toBe(true);
  });
});

describe('renderCatalog', () => {
  it('catalog has one row per tool', async () => {
    const demo = await loadManifest(DEMO);
    const catalog = renderCatalog([demo, { ...demo, name: 'other', alias: 'ot' }]);
    const rows = catalog.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('`demo`');
  });
});

describe('renderCompletions', () => {
  it('zsh completion contains each long flag', async () => {
    const demo = await loadManifest(DEMO);
    const zsh = renderCompletions(demo, 'zsh');
    for (const flag of ['verbose', 'mode', 'count', 'inputs', 'no-input', 'json', 'help']) {
      expect(zsh).toContain(`--${flag}`);
    }
    expect(zsh).toContain('#compdef demo dm');
  });

  it('bash and fish completions name the tool and its flags', async () => {
    const demo = await loadManifest(DEMO);
    expect(renderCompletions(demo, 'bash')).toContain('--verbose');
    const lint = spawnSync('shellcheck', ['-s', 'bash', '-'], {
      input: renderCompletions(demo, 'bash'),
      encoding: 'utf8',
    });
    expect(lint.stdout).toBe('');
    expect(renderCompletions(demo, 'fish')).toContain('complete -c demo -l verbose -s v');
  });
});

describe('shared docs', () => {
  it('extractSharedDocs reads a TSDoc comment, a docstring and a shdoc header', async () => {
    const root = await tempRoot();
    await put(
      root,
      'shared/ts/src/a.ts',
      '/**\n * Adds one.\n *\n * @param n the number.\n */\nexport function inc(n: number): number {\n  return n + 1;\n}\n\nfunction hidden(): void {}\n',
    );
    await put(
      root,
      'shared/py/tbx_shared/b.py',
      'def twice(x: int) -> int:\n    """Doubles x."""\n    return x * 2\n\n\ndef _hidden() -> None:\n    """Not public."""\n',
    );
    await put(
      root,
      'shared/sh/c.sh',
      '# @description Say hi.\n# @arg $1 string Name.\ntbx_hi() {\n  echo hi\n}\n\n_tbx_hidden() {\n  :\n}\n',
    );
    const mods = await extractSharedDocs(root);
    const names = mods.map((mod) => `${mod.lang}/${mod.module}`);
    expect(names).toEqual(['ts/a', 'py/b', 'sh/c']);
    const [ts, py, sh] = mods;
    expect(py?.symbols).toEqual([
      { name: 'twice', signature: 'def twice(x: int) -> int', doc: 'Doubles x.' },
    ]);
    expect(sh?.symbols.map((s) => s.name)).toEqual(['tbx_hi']);
    expect(sh?.symbols[0]?.doc).toContain('Say hi.');
    expect(sh?.symbols[0]?.doc).toContain('@arg $1 string Name.');
    expect(ts?.symbols).toEqual([
      {
        name: 'inc',
        signature: 'function inc(n: number): number',
        doc: 'Adds one.\n\n@param n the number.',
      },
    ]);
  });

  it('missingSharedDocs names an undocumented public function', () => {
    expect(missingSharedDocs(MODULES)).toEqual(['py/b.bare']);
  });

  it('shared index lists every module once', () => {
    const pages = renderSharedDocs(MODULES);
    const index = pages.find((page) => page.path === 'docs/shared/index.md');
    expect(index?.content.match(/\(ts\/a\.md\)/g)).toHaveLength(1);
    expect(index?.content.match(/\(py\/b\.md\)/g)).toHaveLength(1);
    expect(pages.map((page) => page.path)).toContain('docs/shared/ts/a.md');
  });
});

describe('generateAll and checkDrift', () => {
  let root: string;
  let files: GeneratedFile[];

  beforeAll(async () => {
    root = await tempRoot();
    files = await generateAll(root);
    await writeGenerated(root, files);
  });

  it('writes the readme, completions, catalog and llms.txt', () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'tools/demo/README.md',
        'tools/demo/completions/demo.zsh',
        'tools/demo/completions/demo.bash',
        'tools/demo/completions/demo.fish',
        'docs/catalog.md',
        'docs/llms.txt',
      ]),
    );
  });

  it('checkDrift returns [] after generateAll is written', async () => {
    expect(await checkDrift(root)).toEqual([]);
  });

  it('checkDrift names a file edited by hand', async () => {
    const readme = join(root, 'tools/demo/README.md');
    await writeFile(readme, `${await readFile(readme, 'utf8')}hand edit\n`);
    expect(await checkDrift(root)).toEqual(['tools/demo/README.md']);
    await writeGenerated(root, files);
  });

  it('checkDrift fails on a public symbol without a doc', async () => {
    await put(root, 'shared/ts/src/bare.ts', 'export function bare(): void {}\n');
    const drift = await checkDrift(root);
    expect(drift).toContain('undocumented: ts/bare.bare');
    expect(drift).toContain('docs/shared/ts/bare.md');
  });
});

describe('stale generated files', () => {
  it('reports a stale tool README, completion and shared page, and gen removes them', async () => {
    const root = await tempRoot();
    await syncGenerated(root);
    await put(root, 'tools/gone/README.md', 'old\n');
    await put(root, 'tools/gone/completions/gone.zsh', 'old\n');
    await put(root, 'docs/shared/ts/removed.md', 'old\n');
    await put(root, 'tools/demo/docs/notes.md', 'hand written\n');
    expect([...(await checkDrift(root))].sort()).toEqual([
      'docs/shared/ts/removed.md',
      'tools/gone/README.md',
      'tools/gone/completions/gone.zsh',
    ]);
    await syncGenerated(root);
    expect(await checkDrift(root)).toEqual([]);
    await expect(readFile(join(root, 'tools/gone/README.md'))).rejects.toThrow();
    await expect(readFile(join(root, 'docs/shared/ts/removed.md'))).rejects.toThrow();
    expect(await readFile(join(root, 'tools/demo/docs/guide.md'), 'utf8')).toContain('Demo guide');
    expect(await readFile(join(root, 'tools/demo/docs/notes.md'), 'utf8')).toBe('hand written\n');
  });
});

describe('guide link', () => {
  it('readme links the guide only when it exists', async () => {
    const demo = await loadManifest(DEMO);
    const withGuide = renderToolReadme(demo, { hasGuide: true });
    expect(withGuide).toContain('## Guide');
    expect(withGuide).toContain('[docs/guide.md](docs/guide.md)');
    expect(renderToolReadme(demo)).not.toContain('## Guide');
    expect(renderToolReadme(demo, { hasGuide: false })).not.toContain('## Guide');
    expect(renderToolReadme(demo, { hasGuide: true })).toBe(withGuide);
  });

  it('generateAll detects docs/guide.md', async () => {
    const root = await tempRoot();
    const files = await generateAll(root);
    expect(files.find((f) => f.path === 'tools/demo/README.md')?.content).toContain('## Guide');
    await rm(join(root, 'tools/demo/docs'), { recursive: true });
    const after = await generateAll(root);
    expect(after.find((f) => f.path === 'tools/demo/README.md')?.content).not.toContain('## Guide');
  });
});

describe('llms.txt', () => {
  it('uses markdown link entries and links the catalog and shared index', async () => {
    const root = await tempRoot();
    await put(root, 'shared/sh/z.sh', '# @description Hi.\nz_hi() {\n  :\n}\n');
    const llms = (await generateAll(root)).find((f) => f.path === 'docs/llms.txt')?.content ?? '';
    expect(llms).toContain('- [Tool catalog](docs/catalog.md): ');
    expect(llms).toContain('- [Shared modules](docs/shared/index.md): ');
    expect(llms).toContain(
      '- [demo](tools/demo/README.md): Demo tool for parser and generator tests',
    );
    expect(llms).toContain('- [sh/z](docs/shared/sh/z.md): z_hi');
    expect(llms).not.toContain('\n\n\n');
  });

  it('omits the Tools section when there are no tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tbx-gen-'));
    const llms = (await generateAll(root)).find((f) => f.path === 'docs/llms.txt')?.content ?? '';
    expect(llms).not.toContain('## Tools');
    expect(llms).not.toContain('\n\n\n');
  });
});

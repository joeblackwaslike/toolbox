import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { syncGenerated } from '../../shared/ts/src/gen/index.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { CURRENT_PLATFORM } from '../../tbx/src/stage.ts';
import { scaffoldRoot } from './roots.ts';

type Lang = 'ts' | 'py' | 'sh';

const NO_PATH = { path: '', vars: {} };
const OTHER_PLATFORM = CURRENT_PLATFORM === 'macos' ? 'linux' : 'macos';

const UNIT_TESTS: Record<Lang, (name: string) => string> = {
  ts: (name) => `tests/unit/${name}.test.ts`,
  py: (name) => `tests/unit/test_${name.replaceAll('-', '_')}.py`,
  sh: (name) => `tests/unit/${name}.bats`,
};

const E2E_TESTS: Record<Lang, (name: string, expected: string) => [string, string]> = {
  ts: (name, expected) => [
    `tests/e2e/${name}-installed.test.ts`,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { describe, expect, it } from 'vitest';",
      '',
      `describe('installed ${name}', () => {`,
      "  it('prints its name as JSON', () => {",
      "    const bin = process.env.TBX_TOOL_BIN ?? '';",
      "    const stdout = execFileSync(bin, ['--json'], { encoding: 'utf8' });",
      `    expect(JSON.parse(stdout) as unknown).toBe('${expected}');`,
      '  });',
      '});',
      '',
    ].join('\n'),
  ],
  py: (name, expected) => [
    `tests/e2e/test_${name.replaceAll('-', '_')}_installed.py`,
    [
      'import json',
      'import os',
      'import subprocess',
      '',
      '',
      'def test_installed_tool_prints_its_name() -> None:',
      '    proc = subprocess.run(',
      '        [os.environ["TBX_TOOL_BIN"], "--json"],',
      '        capture_output=True,',
      '        text=True,',
      '        check=False,',
      '        timeout=30,',
      '    )',
      '    assert proc.returncode == 0, proc.stderr',
      `    assert json.loads(proc.stdout) == "${expected}"`,
      '',
    ].join('\n'),
  ],
  sh: (name, expected) => [
    `tests/e2e/${name}-installed.bats`,
    [
      '#!/usr/bin/env bats',
      '',
      `@test "installed ${name} prints its name as JSON in an isolated HOME" {`,
      '  [[ "$HOME" == */tbx-verify-*/home ]]',
      '  run "$TBX_TOOL_BIN" --json',
      '  [ "$status" -eq 0 ]',
      `  [ "$output" = '"${expected}"' ]`,
      '}',
      '',
    ].join('\n'),
  ],
};

async function edit(file: string, change: (text: string) => string): Promise<void> {
  await writeFile(file, change(await readFile(file, 'utf8')));
}

/** A temp root of scaffolded fixture tools; `tool` is the path of a file under `tools/<name>`. */
export class VerifyFixtures {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Creates a scaffold root with no tools (the manifest-only `demo` fixture is removed). */
  static async create(): Promise<VerifyFixtures> {
    const root = await scaffoldRoot();
    await rm(join(root, 'tools/demo'), { recursive: true, force: true });
    return new VerifyFixtures(root);
  }

  /** Path of `file` inside `tools/<name>`. */
  tool(name: string, file: string): string {
    return join(this.root, 'tools', name, file);
  }

  /** `tbx new <name> --lang <lang>`, then the RED placeholder test made to pass. */
  async passing(name: string, lang: Lang): Promise<void> {
    const result = await runTbx(['new', name, '--lang', lang], { root: this.root, ...NO_PATH });
    expect(result).toMatchObject({ code: 0 });
    await edit(this.tool(name, UNIT_TESTS[lang](name)), (text) =>
      text.replaceAll(`replace with what ${name} prints`, name),
    );
  }

  /** `tbx new <name> --lang <lang>`, keeping the failing placeholder test. */
  async failing(name: string, lang: Lang): Promise<void> {
    const result = await runTbx(['new', name, '--lang', lang], { root: this.root, ...NO_PATH });
    expect(result).toMatchObject({ code: 0 });
  }

  /**
   * Adds an e2e test that runs the installed binary from `TBX_TOOL_BIN` and expects it to print
   * `expected` (its name by default; anything else makes the test fail).
   */
  async withE2e(name: string, lang: Lang, expected = name): Promise<void> {
    const [file, content] = E2E_TESTS[lang](name, expected);
    await mkdir(join(this.tool(name, file), '..'), { recursive: true });
    await writeFile(this.tool(name, file), content);
  }

  /** Appends TOML to `tools/<name>/tool.toml`. */
  async manifest(name: string, toml: string): Promise<void> {
    await appendFile(this.tool(name, 'tool.toml'), `\n${toml}\n`);
  }

  /** Restricts a tool to the platform this test does not run on. */
  async elsewhere(name: string): Promise<void> {
    await edit(this.tool(name, 'tool.toml'), (text) =>
      text.replace(/^platforms = .*$/m, `platforms = ["${OTHER_PLATFORM}"]`),
    );
  }

  /** Rewrites one file of a tool. */
  async rewrite(name: string, file: string, change: (text: string) => string): Promise<void> {
    await edit(this.tool(name, file), change);
  }

  /** Regenerates READMEs and docs after manifest edits. */
  async regenerate(): Promise<void> {
    await syncGenerated(this.root);
  }
}

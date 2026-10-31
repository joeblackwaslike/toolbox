import { appendFile, lstat, readdir, readlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { findOnPath } from '../../shared/ts/src/paths.ts';
import { runOpen } from '../../shared/ts/src/run.ts';
import { type VerifyReport, verifyTool } from '../../tbx/src/commands/verify.ts';
import { runTbx } from '../../tbx/src/index.ts';
import { ALLOWED_COMMANDS, createIsolatedEnv } from '../../tbx/src/isolated-env.ts';
import { exists } from '../helpers/release.ts';
import { VerifyFixtures } from '../helpers/verify-fixtures.ts';

const REAL_HOMES = [homedir(), userInfo().homedir].filter((home) => home.length > 1);
const VERIFY_TIMEOUT_MS = 300_000;
const SHORT_PTY_DEADLINE_MS = 2000;
const HANG_BUDGET_MS = 60_000;
const NO_PATH = { path: '', vars: {} };

function statuses(report: VerifyReport): Record<string, string> {
  return Object.fromEntries(report.steps.map((step) => [step.name, step.status]));
}

function explain(report: VerifyReport): string {
  return JSON.stringify(report.steps, null, 1);
}

function detailOf(report: VerifyReport, name: string): string {
  return report.steps.find((step) => step.name === name)?.detail ?? '';
}

const ALL_PASS = {
  lint: 'pass',
  unit: 'pass',
  drift: 'pass',
  contract: 'pass',
  e2e: 'pass',
  units: 'skipped',
};

let fixtures: VerifyFixtures;

beforeAll(async () => {
  fixtures = await VerifyFixtures.create();
  for (const lang of ['ts', 'py', 'sh'] as const) {
    await fixtures.passing(`v-${lang}`, lang);
    await fixtures.withE2e(`v-${lang}`, lang);
  }
  await fixtures.passing('v-drift', 'sh');
  await fixtures.passing('v-flag', 'ts');
  await fixtures.manifest(
    'v-flag',
    '[[options]]\nlong = "quiet"\nsummary = "Say less"\ntype = "bool"',
  );
  await fixtures.rewrite('v-flag', 'src/index.ts', (text) =>
    text.replace(
      'await defineTool',
      "if (process.argv.includes('--quiet')) process.exit(2);\n\nawait defineTool",
    ),
  );
  await fixtures.failing('v-bad', 'sh');
  await fixtures.rewrite('v-bad', 'src/v-bad', (text) =>
    text.replace('tbx_result', 'echo $HOME >/dev/null\ntbx_result'),
  );
  await fixtures.passing('v-hang', 'sh');
  await fixtures.rewrite('v-hang', 'src/v-hang', (text) =>
    text.replace('tbx_result', 'if [ -t 0 ]; then sleep 600; fi\ntbx_result'),
  );
  await fixtures.passing('v-unit', 'sh');
  await fixtures.manifest('v-unit', '[unit]\nkind = "daemon"\nrunAtLoad = true');
  await fixtures.elsewhere('v-unit');
  await fixtures.passing('v-here', 'sh');
  await fixtures.manifest('v-here', '[unit]\nkind = "daemon"\nrunAtLoad = true');
  await fixtures.passing('v-home', 'sh');
  await appendFile(
    fixtures.tool('v-home', 'tests/unit/v-home.bats'),
    [
      '',
      '@test "unit tests run with an isolated HOME and XDG directories" {',
      '  [[ "$HOME" == */tbx-verify-*/home ]]',
      '  [[ "$XDG_CONFIG_HOME" == "$HOME/.config" ]]',
      '  [[ "$TBX_BIN_DIR" == "$HOME/.local/share/tbx/bin" ]]',
      '}',
      '',
    ].join('\n'),
  );
  await fixtures.regenerate();
  await appendFile(fixtures.tool('v-drift', 'README.md'), '\nA hand edit.\n');
  await appendFile(fixtures.tool('v-bad', 'README.md'), '\nA hand edit.\n');
}, VERIFY_TIMEOUT_MS);

describe('verifyTool', () => {
  it.each(['ts', 'py', 'sh'])(
    'verify passes for a correct tool (%s)',
    async (lang) => {
      const report = await verifyTool(fixtures.root, `v-${lang}`);
      expect(report.steps.map((step) => step.name)).toEqual(Object.keys(ALL_PASS));
      expect(statuses(report), explain(report)).toEqual(ALL_PASS);
      expect(detailOf(report, 'units')).toBe('no unit');
      expect(report.ok).toBe(true);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'unit tests see an isolated HOME and XDG directories, never the real ones',
    async () => {
      const report = await verifyTool(fixtures.root, 'v-home');
      expect(statuses(report), explain(report)).toEqual(ALL_PASS);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'verify fails the drift step after a hand edit to README.md',
    async () => {
      const report = await verifyTool(fixtures.root, 'v-drift');
      expect(statuses(report), explain(report)).toEqual({ ...ALL_PASS, drift: 'fail' });
      expect(detailOf(report, 'drift')).toContain('tools/v-drift/README.md');
      expect(report.ok).toBe(false);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'verify fails the contract step when the parser rejects a documented flag',
    async () => {
      const report = await verifyTool(fixtures.root, 'v-flag');
      expect(statuses(report), explain(report)).toEqual({ ...ALL_PASS, contract: 'fail' });
      expect(detailOf(report, 'contract')).toContain('option --quiet');
      expect(report.ok).toBe(false);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'verify reports every failing step, not just the first',
    async () => {
      const report = await verifyTool(fixtures.root, 'v-bad');
      expect(statuses(report), explain(report)).toEqual({
        ...ALL_PASS,
        lint: 'fail',
        unit: 'fail',
        drift: 'fail',
      });
      expect(detailOf(report, 'lint')).toContain('SC2086');
      expect(detailOf(report, 'unit')).toContain('not ok');
      expect(report.ok).toBe(false);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'a pty session that never exits is killed at the deadline and fails the e2e step',
    async () => {
      const started = Date.now();
      const report = await verifyTool(fixtures.root, 'v-hang', {
        ptyDeadlineMs: SHORT_PTY_DEADLINE_MS,
      });
      expect(statuses(report), explain(report)).toEqual({ ...ALL_PASS, e2e: 'fail' });
      expect(detailOf(report, 'e2e')).toMatch(/^interactive run .*killed at the 2s deadline/);
      expect(Date.now() - started).toBeLessThan(HANG_BUDGET_MS);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'a tool with a unit on a non-matching platform skips the units step',
    async () => {
      const report = await verifyTool(fixtures.root, 'v-unit');
      const elsewhere = /does not run on (macos|linux)/;
      expect(statuses(report), explain(report)).toEqual({
        lint: 'pass',
        unit: 'skipped',
        drift: 'pass',
        contract: 'skipped',
        e2e: 'skipped',
        units: 'skipped',
      });
      expect(detailOf(report, 'units')).toMatch(elsewhere);
      expect(report.ok).toBe(true);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'a tool with a unit on this platform validates it, skipping only when the validator is missing',
    async () => {
      const validator = process.platform === 'darwin' ? 'plutil' : 'systemd-analyze';
      const present = (await findOnPath(validator, process.env.PATH ?? '')) !== null;
      const local = await verifyTool(fixtures.root, 'v-here', { ci: false });
      expect(statuses(local), explain(local)).toEqual({
        ...ALL_PASS,
        units: present ? 'pass' : 'skipped',
      });
      if (!present) expect(detailOf(local, 'units')).toMatch(/^warning: /);
    },
    VERIFY_TIMEOUT_MS,
  );
});

describe('tbx verify', () => {
  it('exits 2 for an unknown tool or a missing target', async () => {
    const root = fixtures.root;
    expect(await runTbx(['verify', 'nope'], { root, ...NO_PATH })).toMatchObject({ code: 2 });
    expect(await runTbx(['verify'], { root, ...NO_PATH })).toMatchObject({ code: 2 });
    expect(await runTbx(['verify', 'v-sh', '--all'], { root, ...NO_PATH })).toMatchObject({
      code: 2,
    });
  });

  it('verify --all with no tools succeeds and says so', async () => {
    const empty = await VerifyFixtures.create();
    const result = await runTbx(['verify', '--all'], { root: empty.root, ...NO_PATH });
    expect(result).toMatchObject({ code: 0, stdout: 'no tools to verify\n' });
  });

  it(
    'prints one line per step and exits 1 when a step fails',
    async () => {
      const result = await runTbx(['verify', 'v-drift'], { root: fixtures.root, ...NO_PATH });
      expect(result.code).toBe(1);
      const lines = result.stdout.split('\n');
      expect(lines[0]).toBe('v-drift: FAILED');
      for (const step of Object.keys(ALL_PASS)) {
        expect(lines.some((line) => new RegExp(`^  (pass|fail|skipped) +${step}`).test(line))).toBe(
          true,
        );
      }
      expect(result.stdout).toMatch(/^ {2}fail +drift\n {4}.*tools\/v-drift\/README\.md/m);
    },
    VERIFY_TIMEOUT_MS,
  );

  it(
    'verify --all --json reports every tool and exits 1 when one fails',
    async () => {
      const two = await VerifyFixtures.create();
      await two.passing('a-ok', 'sh');
      await two.passing('a-bad', 'sh');
      await appendFile(two.tool('a-bad', 'README.md'), '\nA hand edit.\n');
      const result = await runTbx(['verify', '--all', '--json'], { root: two.root, ...NO_PATH });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        tools: (VerifyReport & { name: string })[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.tools.map((tool) => [tool.name, tool.ok])).toEqual([
        ['a-bad', false],
        ['a-ok', true],
      ]);
    },
    VERIFY_TIMEOUT_MS,
  );
});

function inside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..');
}

describe('createIsolatedEnv', () => {
  it('isolated env never exposes the real HOME', async () => {
    const isolated = await createIsolatedEnv();
    try {
      const { env, home } = isolated;
      expect(env.HOME).toBe(home);
      for (const real of REAL_HOMES) {
        for (const [key, value] of Object.entries(env)) {
          expect(value?.includes(real), `${key}=${value ?? ''}`).toBe(false);
        }
      }
      for (const key of [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TBX_BIN_DIR',
        'TMPDIR',
      ]) {
        expect(inside(env[key] ?? '', home), key).toBe(true);
      }
      const printed = await runOpen('env', [], { env, cwd: home });
      expect(printed.status).toBe(0);
      for (const real of REAL_HOMES) expect(printed.stdout).not.toContain(real);
      const expanded = await runOpen(
        'python3',
        ['-I', '-c', 'import os; print(os.path.expanduser("~"))'],
        { env, cwd: home },
      );
      expect(expanded.stdout.trim()).toBe(home);
    } finally {
      await isolated.cleanup();
    }
  });

  it('sends HTTP from tools to a dead local proxy, with no proxy bypass', async () => {
    const isolated = await createIsolatedEnv();
    try {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        expect(isolated.env[name], name).toBe('http://127.0.0.1:9');
        expect(isolated.env[name.toLowerCase()], name.toLowerCase()).toBe('http://127.0.0.1:9');
      }
      expect(isolated.env.NO_PROXY).toBe('');
      expect(isolated.env.no_proxy).toBe('');
    } finally {
      await isolated.cleanup();
    }
  });

  it('puts only allowlisted command links on PATH and cleans up idempotently', async () => {
    const isolated = await createIsolatedEnv();
    const entries = (isolated.env.PATH ?? '').split(delimiter);
    expect(entries).toHaveLength(1);
    const [stubs = ''] = entries;
    const names = await readdir(stubs);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(ALLOWED_COMMANDS).toContain(name);
      expect((await lstat(join(stubs, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(stubs, name))).not.toBe('');
    }
    expect(names).toEqual(expect.arrayContaining(['sh', 'bash', 'env', 'python3', 'bun']));
    expect(await runOpen('git', ['--version'], { env: isolated.env }).catch(() => null)).toBe(null);
    await isolated.cleanup();
    await isolated.cleanup();
    expect(await exists(isolated.home)).toBe(false);
    expect(await exists(stubs)).toBe(false);
  });
});

describe('root test runners', () => {
  it(
    'skip tools/*/tests/e2e, which only verify runs against an installed binary',
    async () => {
      const roots = await VerifyFixtures.create();
      for (const lang of ['ts', 'py', 'sh'] as const) {
        await roots.passing(`x-${lang}`, lang);
        await roots.withE2e(`x-${lang}`, lang, 'not-the-name');
      }
      const { root } = roots;
      await runOpen('git', ['init', '-q'], { cwd: root });
      const runners: [string, string[]][] = [
        [join(root, 'node_modules/.bin/vitest'), ['run']],
        ['uv', ['run', 'pytest', '-p', 'no:faulthandler', '--no-header', '-q', 'tools']],
        ['just', ['test-sh']],
      ];
      for (const [command, args] of runners) {
        const result = await runOpen(command, args, {
          cwd: root,
          closeStdin: true,
          timeoutMs: VERIFY_TIMEOUT_MS,
        });
        expect(result.status, `${command}\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/installed/);
      }
      for (const lang of ['ts', 'py', 'sh']) {
        const report = await verifyTool(root, `x-${lang}`);
        expect(statuses(report), explain(report)).toEqual({ ...ALL_PASS, e2e: 'fail' });
        expect(detailOf(report, 'e2e')).toMatch(/not-the-name/);
      }
    },
    VERIFY_TIMEOUT_MS,
  );
});

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { usageOf } from '../../shared/ts/src/cli.ts';
import { type ContractCase, generateContractTests } from '../../shared/ts/src/gen/contract.ts';
import { type ToolManifest, loadManifest, parseManifest } from '../../shared/ts/src/manifest.ts';
import { runOpen } from '../helpers/run.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const python = execFileSync(
  'uv',
  ['run', '--frozen', 'python', '-c', 'import sys; print(sys.executable)'],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
).trim();

const LANGUAGES: [string, string, string[]][] = [
  ['ts', 'bun', [`${FIXTURES}cli/demo.ts`]],
  ['py', python, [`${FIXTURES}cli/demo_py.py`]],
  ['sh', 'bash', [`${FIXTURES}cli/demo.sh`]],
];

let manifest: ToolManifest;
let cases: ContractCase[];

beforeAll(async () => {
  manifest = await loadManifest(`${FIXTURES}tools/demo/tool.toml`);
  cases = generateContractTests(manifest);
});

describe('generateContractTests', () => {
  it('emits one case per documented option', () => {
    for (const option of usageOf(manifest).options) {
      expect(cases.filter((c) => c.name === `option --${option.long}`)).toHaveLength(1);
      if (option.short !== null) {
        expect(cases.filter((c) => c.name === `option -${option.short}`)).toHaveLength(1);
      }
    }
  });

  it('covers each missing required argument with -y and --json, an unknown flag and a bad int', () => {
    const names = cases.map((c) => c.name);
    expect(names).toContain('missing src with -y');
    expect(names).toContain('missing src with --json');
    expect(names).toContain('unknown flag');
    expect(names).toContain('too many arguments');
    expect(names).toContain('non-integer --count');
    expect(cases.find((c) => c.name === 'missing src with -y')).toEqual({
      name: 'missing src with -y',
      argv: ['-y'],
      expectExit: 2,
    });
    expect(cases.find((c) => c.name === 'option --json')).toMatchObject({ expectStdout: 'json' });
  });

  it('never lets a case reach the tool body', () => {
    for (const c of cases) {
      expect(c.expectExit !== 0 || c.argv.includes('--help') || c.argv.includes('-h')).toBe(true);
    }
  });

  it('gives value options a placeholder value and skips missing cases without arguments', () => {
    const bare = parseManifest(`
name = "bare"
summary = "No arguments"
language = "sh"
version = "1.0.0"
platforms = ["linux"]
[[options]]
long = "level"
summary = "Level"
type = "int"
`);
    const generated = generateContractTests(bare);
    expect(generated.find((c) => c.name === 'option --level')?.argv).toEqual([
      '--level',
      '1',
      '--help',
    ]);
    expect(generated.some((c) => c.name.startsWith('missing'))).toBe(false);
  });
});

describe.each(LANGUAGES)('contract cases against the %s demo', (_language, command, prefix) => {
  it('every case exits as expected, with JSON-only stdout where required', async () => {
    for (const c of cases) {
      const result = await runOpen(command, [...prefix, ...c.argv]);
      expect({ name: c.name, timedOut: result.timedOut, status: result.status }).toEqual({
        name: c.name,
        timedOut: false,
        status: c.expectExit,
      });
      if (c.expectStdout === 'json') {
        expect(() => JSON.parse(result.stdout) as unknown, c.name).not.toThrow();
      }
      if (c.expectExit !== 0) expect(result.stdout, c.name).toBe('');
    }
  });
});

describe('cross-language parity', () => {
  it('all three languages agree on an option named next to a built-in', async () => {
    for (const [language, command, prefix] of LANGUAGES) {
      const given = await runOpen(command, [
        ...prefix,
        'in.txt',
        '--inputs',
        'f.txt',
        '-y',
        '--json',
      ]);
      expect(JSON.parse(given.stdout), language).toMatchObject({
        opts: { verbose: false, mode: 'fast', inputs: 'f.txt' },
      });
      const short = await runOpen(command, [...prefix, 'in.txt', '-yi', 'g.txt', '--json']);
      expect(JSON.parse(short.stdout), language).toMatchObject({ opts: { inputs: 'g.txt' } });
      const omitted = await runOpen(command, [...prefix, 'in.txt', '-y', '--json']);
      expect(JSON.parse(omitted.stdout), language).toMatchObject({
        opts: { verbose: false, mode: 'fast' },
      });
      expect(JSON.parse(omitted.stdout).opts, language).not.toHaveProperty('inputs');
    }
  });

  it('all three languages print the same --help --json and the same parsed context', async () => {
    const golden: unknown = JSON.parse(await readFile(`${FIXTURES}tools/demo/usage.json`, 'utf8'));
    const argv = ['in.txt', 'out.txt', '-v', '-m', 'slow', '--count', '2', '--json'];
    for (const [language, command, prefix] of LANGUAGES) {
      const help = await runOpen(command, [...prefix, '--help', '--json']);
      expect(JSON.parse(help.stdout), language).toEqual(golden);
      const run = await runOpen(command, [...prefix, ...argv]);
      expect(JSON.parse(run.stdout), language).toEqual({
        args: { src: 'in.txt', dest: 'out.txt' },
        opts: { verbose: true, mode: 'slow', count: 2 },
        json: true,
        interactive: false,
      });
    }
  });
});

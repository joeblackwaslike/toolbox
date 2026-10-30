import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolContext, runTool, usageOf } from '../../shared/ts/src/cli.ts';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { type ToolManifest, loadManifest } from '../../shared/ts/src/manifest.ts';
import { runOpen } from '../helpers/run.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const DEMO_TS = `${FIXTURES}cli/demo.ts`;

let manifest: ToolManifest;
let golden: unknown;

beforeAll(async () => {
  manifest = await loadManifest(`${FIXTURES}tools/demo/tool.toml`);
  golden = JSON.parse(await readFile(`${FIXTURES}tools/demo/usage.json`, 'utf8'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

async function invoke(
  argv: string[],
  stdinIsTTY = false,
): Promise<{ code: number; ctx: ToolContext | undefined; out: string; err: string }> {
  const streams = capture();
  let seen: ToolContext | undefined;
  const code = await runTool(
    manifest,
    (ctx) => {
      seen = ctx;
      return Promise.resolve();
    },
    argv,
    stdinIsTTY,
  );
  vi.restoreAllMocks();
  return { code, ctx: seen, out: streams.out.join(''), err: streams.err.join('') };
}

describe('defineTool (subprocess, non-tty stdin left open)', () => {
  it('exits 2 when a required argument is missing and -y is set', async () => {
    const result = await runOpen('bun', [DEMO_TS, '-y']);
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(ExitCode.usage);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("missing required argument 'src'");
    expect(result.stderr).toContain('Usage: demo [options] <src> [dest]');
  });

  it('--json on a non-tty stdin prints valid JSON only to stdout', async () => {
    const result = await runOpen('bun', [DEMO_TS, 'in.txt', '--json', '-v', '--count', '3']);
    expect(result.status).toBe(ExitCode.ok);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      args: { src: 'in.txt' },
      opts: { verbose: true, mode: 'fast', count: 3 },
      json: true,
      interactive: false,
    });
  });

  it('maps a ToolError to its exit code', async () => {
    const result = await runOpen('bun', [DEMO_TS, 'fail']);
    expect(result.status).toBe(ExitCode.config);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('failed on purpose');
  });
});

describe('runTool', () => {
  it('--help --json output deep-equals the manifest-derived usage', async () => {
    const result = await invoke(['--help', '--json']);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.ctx).toBeUndefined();
    expect(JSON.parse(result.out)).toEqual(golden);
    expect(usageOf(manifest)).toEqual(golden);
  });

  it('unknown flag exits 2', async () => {
    const result = await invoke(['in.txt', '--bogus']);
    expect(result.code).toBe(ExitCode.usage);
    expect(result.ctx).toBeUndefined();
    expect(result.out).toBe('');
    expect(result.err).toContain('Usage: demo');
  });

  it('exits 2 for a non-integer int option', async () => {
    const result = await invoke(['in.txt', '--count', 'many']);
    expect(result.code).toBe(ExitCode.usage);
    expect(result.ctx).toBeUndefined();
  });

  it('exits 2 for too many arguments', async () => {
    expect((await invoke(['a', 'b', 'c'])).code).toBe(ExitCode.usage);
  });

  it('prints human help to stdout and exits 0 without required arguments', async () => {
    const result = await invoke(['-h']);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.out).toContain('Usage: demo [options] <src> [dest]');
    expect(result.out).toContain('--no-input');
    expect(result.err).toBe('');
  });

  it('parses arguments, short forms, defaults and --opt=value', async () => {
    const result = await invoke(['in.txt', 'out.txt', '-m', 'slow', '--count=2']);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.ctx?.args).toEqual({ src: 'in.txt', dest: 'out.txt' });
    expect(result.ctx?.opts).toEqual({ verbose: false, mode: 'slow', count: 2 });
    expect(result.ctx?.json).toBe(false);
  });

  it('is interactive only on a tty without -y, --no-input or --json', async () => {
    expect((await invoke(['in.txt'], true)).ctx?.interactive).toBe(true);
    expect((await invoke(['in.txt'], false)).ctx?.interactive).toBe(false);
    expect((await invoke(['in.txt', '-y'], true)).ctx?.interactive).toBe(false);
    expect((await invoke(['in.txt', '--no-input'], true)).ctx?.interactive).toBe(false);
    expect((await invoke(['in.txt', '--json'], true)).ctx?.interactive).toBe(false);
  });

  it('treats arguments after -- as positionals', async () => {
    const result = await invoke(['--', '--not-a-flag']);
    expect(result.ctx?.args).toEqual({ src: '--not-a-flag' });
  });

  it('returns the ToolError code and writes the message to stderr', async () => {
    const streams = capture();
    const code = await runTool(
      manifest,
      () => Promise.reject(new ToolError('nope', ExitCode.unavailable)),
      ['in.txt'],
      false,
    );
    expect(code).toBe(ExitCode.unavailable);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toContain('nope');
  });
});

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const VERSION = '9.8.7';
const STUB = '#!/bin/sh\necho "STUB-RAN $*"\n';
const EXITING = '#!/bin/sh\nexit 7\n';
const ASSETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

let work: string;
let server: Server;
let served = STUB;
let hits = 0;
let base: string;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function render(name: string, content: string): string {
  const sums = join(work, `${name}.txt`);
  writeFileSync(sums, ASSETS.map((a) => `${sha(content)}  tbx-${a}\n`).join(''));
  const out = join(work, name);
  const r = spawnSync('bash', [join(ROOT, 'scripts/render-packaging.sh'), VERSION, sums, out], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return join(out, 'npm/bin/tbx.js');
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  launcher: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [launcher, ...args], {
      env: {
        ...process.env,
        TBX_DOWNLOAD_BASE: base,
        XDG_CACHE_HOME: join(work, 'cache'),
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function cached(): string[] {
  try {
    return readdirSync(join(work, 'cache', 'tbx', VERSION));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'tbx-launcher-'));
  server = createServer((req, res) => {
    hits += 1;
    if (!req.url?.startsWith(`/tbx-cli-v${VERSION}/tbx-`)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(served);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  served = STUB;
  hits = 0;
  rmSync(join(work, 'cache'), { recursive: true, force: true });
});

describe('npm launcher', () => {
  it('downloads, verifies and execs the binary with the original arguments', async () => {
    const r = await run(render('ok', STUB), ['install', '--flag']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('STUB-RAN install --flag\n');
    expect(r.status).toBe(0);
    expect(hits).toBe(1);
  });

  it('rejects a tampered download without running or caching it', async () => {
    const launcher = render('tamper', STUB);
    served = '#!/bin/sh\necho TAMPERED\n';
    const r = await run(launcher, ['install']);
    expect(r.stdout).not.toContain('TAMPERED');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum/i);
    expect(cached()).toEqual([]);
  });

  it('uses the cache on the second run', async () => {
    const launcher = render('cache', STUB);
    expect((await run(launcher, ['a'])).status).toBe(0);
    hits = 0;
    const r = await run(launcher, ['b']);
    expect(r.stdout).toBe('STUB-RAN b\n');
    expect(hits).toBe(0);
  });

  it('refuses a plain-http base that is not loopback', async () => {
    const r = await run(render('http', STUB), ['x'], { TBX_DOWNLOAD_BASE: 'http://example.com' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/https/i);
  });

  it('exits with the binary exit status', async () => {
    served = EXITING;
    expect((await run(render('exit', EXITING), [])).status).toBe(7);
  });
});

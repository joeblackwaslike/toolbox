import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL, exists, layout, publish, sandbox, tamper } from '../helpers/release.ts';
import type { Sandbox } from '../helpers/release.ts';
import { REPO } from '../helpers/roots.ts';

let box: Sandbox;
let server: Server;
let base: string;

beforeAll(async () => {
  box = await sandbox();
  await publish(box, '1.0.0');
  server = createServer((req, res) => {
    readFile(join(box.releases, (req.url ?? '/').slice(1)))
      .then((bytes) => res.end(bytes))
      .catch(() => res.writeHead(404).end());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const run = promisify(execFile);

async function install(index: string) {
  try {
    const out = await run('bun', ['tbx/src/index.ts', 'install', TOOL, '--index', index], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', HOME: box.home },
    });
    return { status: 0, stderr: out.stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { status: failed.code, stderr: failed.stderr };
  }
}

describe('tbx install from a remote index', () => {
  it('links the tool and records its version, then refuses a corrupted artifact', async () => {
    const paths = layout(box.home);
    const result = await install(`${base}/index.json`);
    expect(result.status, result.stderr).toBe(0);
    expect(await exists(paths.link)).toBe(true);
    expect(JSON.parse(await readFile(paths.state, 'utf8'))).toMatchObject({
      tools: { [TOOL]: { version: '1.0.0' } },
    });
  });

  it('fails with nothing linked when the served tarball is corrupted', async () => {
    const fresh = await sandbox();
    box = { home: fresh.home, releases: box.releases };
    await tamper(box, '1.0.0');
    const result = await install(`${base}/index.json`);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('checksum mismatch');
    expect(await exists(layout(box.home).link)).toBe(false);
    expect(await exists(layout(box.home).tools)).toBe(false);
  });
});

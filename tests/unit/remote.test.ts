import { mkdtemp, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { sha256 } from '../../tbx/src/archive.ts';
import type { IndexEntry } from '../../tbx/src/commands/build.ts';
import { fetchArtifact, fetchIndex } from '../../tbx/src/remote.ts';

const BODY = Buffer.from('artifact bytes');

let server: Server;
let base: string;

function entry(artifact: string, hash = sha256(BODY)): IndexEntry {
  return { name: 'demo', version: '1.0.0', artifact, sha256: hash };
}

let secondHits = 0;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/index.json') {
      res.end(JSON.stringify({ tools: [entry(`${base}/demo.tar.gz`)] }));
    } else if (req.url === '/demo.tar.gz') {
      res.end(BODY);
    } else if (req.url === '/redirect-to-insecure') {
      res.writeHead(302, { Location: `http://localhost:${port}/second` }).end();
    } else if (req.url === '/second') {
      secondHits += 1;
      res.end(BODY);
    } else if (req.url === '/redirect-once') {
      res.writeHead(302, { Location: `${base}/demo.tar.gz` }).end();
    } else if (req.url === '/redirect-loop') {
      res.writeHead(302, { Location: `${base}/redirect-loop` }).end();
    } else if (req.url === '/moved/index.json') {
      res.writeHead(302, { Location: `${base}/moved/dir/index.json` }).end();
    } else if (req.url === '/moved/dir/index.json') {
      res.end(JSON.stringify({ tools: [] }));
    } else if (req.url === '/moved/dir/demo.tar.gz') {
      res.end(BODY);
    } else if (req.url === '/moved-missing/index.json') {
      res.writeHead(302, { Location: `${base}/missing.json` }).end();
    } else if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': '1000000' });
      res.write(BODY);
      res.destroy();
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

async function rejection(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe('fetchIndex', () => {
  it('reads entries from an http URL on 127.0.0.1', async () => {
    const entries = await fetchIndex(`${base}/index.json`);
    expect(entries.map((e) => e.name)).toEqual(['demo']);
  });

  it('reads entries from a local path and from a file: URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-remote-'));
    const file = join(dir, 'index.json');
    await writeFile(file, JSON.stringify({ tools: [entry('demo.tar.gz')] }));
    expect(await fetchIndex(file)).toHaveLength(1);
    expect(await fetchIndex(pathToFileURL(file).href)).toHaveLength(1);
  });

  it('rejects a non-2xx status', async () => {
    await rejection(fetchIndex(`${base}/missing.json`));
  });

  it('rejects http: for a host other than 127.0.0.1', async () => {
    const error = await rejection(fetchIndex('http://example.com/index.json'));
    expect(error.message).toContain('https');
  });

  it('refuses a redirect to a non-loopback host before requesting it', async () => {
    secondHits = 0;
    await rejection(fetchArtifact(entry(`${base}/redirect-to-insecure`), `${base}/index.json`));
    expect(secondHits).toBe(0);
  });

  it('follows a redirect that stays within the allowed hosts', async () => {
    const bytes = await fetchArtifact(entry(`${base}/redirect-once`), `${base}/index.json`);
    expect(bytes.equals(BODY)).toBe(true);
  });

  it('fails clearly after too many redirects', async () => {
    const error = await rejection(
      fetchArtifact(entry(`${base}/redirect-loop`), `${base}/index.json`),
    );
    expect(error.message).toMatch(/too many redirects/);
  });
});

describe('fetchArtifact', () => {
  it('returns the bytes for an absolute URL entry of a remote index', async () => {
    const bytes = await fetchArtifact(entry(`${base}/demo.tar.gz`), `${base}/index.json`);
    expect(bytes.equals(BODY)).toBe(true);
  });

  it('resolves a relative artifact against a remote index', async () => {
    const bytes = await fetchArtifact(entry('demo.tar.gz'), `${base}/index.json`);
    expect(bytes.equals(BODY)).toBe(true);
  });

  it('downloads an absolute artifact URL without re-fetching an unavailable index', async () => {
    const bytes = await fetchArtifact(entry(`${base}/demo.tar.gz`), `${base}/missing.json`);
    expect(bytes.equals(BODY)).toBe(true);
  });

  it('rejects a wrong sha256 with ExitCode.config naming the tool', async () => {
    const error = await rejection(
      fetchArtifact(entry(`${base}/demo.tar.gz`, 'a'.repeat(64)), `${base}/index.json`),
    );
    expect(error.code).toBe(ExitCode.config);
    expect(error.message).toContain('demo');
  });

  it('rejects a non-2xx status', async () => {
    await rejection(fetchArtifact(entry(`${base}/gone.tar.gz`), `${base}/index.json`));
  });

  it('surfaces a truncated body as a ToolError naming the URL', async () => {
    const error = await rejection(fetchArtifact(entry(`${base}/truncated`), `${base}/index.json`));
    expect(error.code).toBe(ExitCode.unavailable);
    expect(error.message).toContain(`${base}/truncated`);
  });

  it('rejects an absolute URL artifact when the index is local', async () => {
    await rejection(fetchArtifact(entry(`${base}/demo.tar.gz`), '/tmp/index.json'));
  });

  it('keeps a local artifact inside the index directory', async () => {
    await rejection(fetchArtifact(entry('../escape.tar.gz'), '/tmp/rel/index.json'));
  });

  it('resolves a relative artifact against the index URL after a redirect to another directory', async () => {
    const bytes = await fetchArtifact(entry('demo.tar.gz'), `${base}/moved/index.json`);
    expect(bytes.equals(BODY)).toBe(true);
  });

  it('rejects a relative artifact when the final index response is a non-2xx status', async () => {
    const error = await rejection(
      fetchArtifact(entry('demo.tar.gz'), `${base}/moved-missing/index.json`),
    );
    expect(error.code).toBe(ExitCode.unavailable);
  });
});

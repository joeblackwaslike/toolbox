import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, ToolError, messageOf } from '../../shared/ts/src/errors.ts';
import { isWithin } from '../../shared/ts/src/paths.ts';
import { sha256 } from './archive.ts';
import { type IndexEntry, parseIndex, readIndex } from './commands/build.ts';

const FETCH_TIMEOUT_MS = 60_000;
const LOOPBACK = '127.0.0.1';
const MAX_REDIRECTS = 5;

function isUrl(source: string): boolean {
  return /^(https?|file):/i.test(source);
}

function isRemote(source: string): boolean {
  return /^https?:/i.test(source);
}

function assertSecure(url: URL): void {
  if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === LOOPBACK)) return;
  throw new ToolError(`${url.href}: only https: URLs are allowed`, ExitCode.config);
}

/** Follows redirects manually, validating each hop's URL before requesting it. */
async function fetchSecure(href: string): Promise<Response> {
  let url = href;
  for (let hop = 0; ; hop += 1) {
    assertSecure(new URL(url));
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch (error) {
      throw new ToolError(`cannot fetch ${url}: ${messageOf(error)}`, ExitCode.unavailable, {
        cause: error,
      });
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new ToolError(`${href}: too many redirects`, ExitCode.unavailable);
    }
    url = new URL(location, url).href;
  }
}

async function download(href: string): Promise<Buffer> {
  const response = await fetchSecure(href);
  if (!response.ok) {
    throw new ToolError(`cannot fetch ${href}: HTTP ${response.status}`, ExitCode.unavailable);
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ToolError(`cannot fetch ${href}: ${messageOf(error)}`, ExitCode.unavailable, {
      cause: error,
    });
  }
}

function localPath(source: string): string {
  return /^file:/i.test(source) ? fileURLToPath(source) : source;
}

/**
 * Reads a release index from a local path, a `file:` URL or an `https:` URL (`http:` only for
 * `127.0.0.1`).
 *
 * @throws {ToolError} exit 78 for an insecure URL or an invalid index, 69 when the fetch fails.
 */
export async function fetchIndex(source: string): Promise<IndexEntry[]> {
  if (!isRemote(source)) return readIndex(localPath(source));
  const bytes = await download(source);
  return parseIndex(bytes.toString('utf8'), source);
}

function localArtifact(indexFile: string, entry: IndexEntry): string {
  const base = path.dirname(path.resolve(indexFile));
  const file = path.resolve(base, entry.artifact);
  if (isUrl(entry.artifact) || path.isAbsolute(entry.artifact) || !isWithin(base, file)) {
    throw new ToolError(
      `${indexFile}: artifact for ${entry.name} must stay inside the index directory`,
      ExitCode.config,
    );
  }
  return file;
}

/**
 * Fetches the artifact of `entry` named by the index at `indexSource` and checks its SHA-256.
 * A local index allows only artifacts inside its directory; a remote index also allows an
 * absolute `https:` artifact URL.
 *
 * @throws {ToolError} exit 78 on a checksum mismatch or an unsafe artifact location, 69 when the
 * fetch fails.
 */
export async function fetchArtifact(entry: IndexEntry, indexSource: string): Promise<Buffer> {
  const bytes = isRemote(indexSource)
    ? await download(new URL(entry.artifact, indexSource).href)
    : await readFile(localArtifact(localPath(indexSource), entry));
  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new ToolError(
      `checksum mismatch for ${entry.name} ${entry.version}: index says ${entry.sha256}, download is ${actual}`,
      ExitCode.config,
    );
  }
  return bytes;
}

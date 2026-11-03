#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pkg = require('../package.json');

const DEFAULT_BASE = 'https://github.com/joeblackwaslike/toolbox/releases/download';
const OS_NAMES = { darwin: 'darwin', linux: 'linux' };
const ARCH_NAMES = { arm64: 'arm64', x64: 'x64' };
const NON_TERMINATING_SIGNALS = new Set([
  'SIGPIPE',
  'SIGUSR1',
  'SIGUSR2',
  'SIGCHLD',
  'SIGWINCH',
  'SIGURG',
  'SIGCONT',
]);
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

function fail(message) {
  process.stderr.write(`tbx: ${message}\n`);
  process.exit(1);
}

function isMusl() {
  process.report.excludeNetwork = true;
  return !process.report.getReport().header.glibcVersionRuntime;
}

function assetName({
  platform = process.platform,
  arch = process.arch,
  musl = platform === 'linux' && isMusl(),
} = {}) {
  const osName = OS_NAMES[platform];
  const archName = ARCH_NAMES[arch];
  if (!osName || !archName) {
    throw new Error(
      `unsupported platform ${platform}/${arch}; need macOS or Linux on arm64 or x64`,
    );
  }
  if (osName === 'linux' && musl) {
    throw new Error(
      'musl-based Linux (such as Alpine) is not supported; the tbx binaries need glibc',
    );
  }
  return `tbx-${osName}-${archName}`;
}

function isAllowedUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
}

function downloadBase() {
  const base = (process.env.TBX_DOWNLOAD_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  if (!isAllowedUrl(base)) {
    throw new Error('the download base must use https (http is allowed only for localhost)');
  }
  return base;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!isAllowedUrl(res.url)) throw new Error(`refusing a redirect to ${res.url}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`download failed: ${url}: ${err.message}`);
  }
}

function install(body, dir, target, asset) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${asset}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function run(target, args) {
  const child = spawn(target, args, { stdio: 'inherit' });
  const handlers = FORWARDED_SIGNALS.map((sig) => {
    const handler = () => child.kill(sig);
    process.on(sig, handler);
    return [sig, handler];
  });
  child.on('error', (err) => fail(`could not run ${target}: ${err.message}`));
  child.on('exit', (code, signal) => {
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
    if (!signal) process.exit(code ?? 1);
    const status = 128 + (os.constants.signals[signal] ?? 1);
    if (NON_TERMINATING_SIGNALS.has(signal)) process.exit(status);
    setTimeout(() => process.exit(status), 100);
    process.kill(process.pid, signal);
  });
}

async function main() {
  const asset = assetName();
  const expected = pkg.tbxChecksums[asset];
  if (!expected) throw new Error(`no checksum for ${asset} in this package`);
  const base = downloadBase();

  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(cacheRoot, 'tbx', pkg.version);
  const target = path.join(dir, asset);

  let cachedOk = false;
  try {
    cachedOk = sha256(fs.readFileSync(target)) === expected;
  } catch {
    cachedOk = false;
  }

  if (!cachedOk) {
    const body = await download(`${base}/tbx-cli-v${pkg.version}/${asset}`);
    if (sha256(body) !== expected) {
      throw new Error(`checksum mismatch for ${asset}; refusing to run the download`);
    }
    install(body, dir, target, asset);
  }

  run(target, process.argv.slice(2));
}

module.exports = { assetName, isAllowedUrl };

if (require.main === module) {
  main().catch((err) => fail(err.message));
}

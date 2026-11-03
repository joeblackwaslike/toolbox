#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const DEFAULT_BASE = 'https://github.com/joeblackwaslike/toolbox/releases/download';
const OS_NAMES = { darwin: 'darwin', linux: 'linux' };
const ARCH_NAMES = { arm64: 'arm64', x64: 'x64' };

function fail(message) {
  process.stderr.write(`tbx: ${message}\n`);
  process.exit(1);
}

function isMusl() {
  try {
    return fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

function assetName() {
  const osName = OS_NAMES[process.platform];
  const arch = ARCH_NAMES[process.arch];
  if (!osName || !arch) {
    fail(
      `unsupported platform ${process.platform}/${process.arch}; need macOS or Linux on arm64 or x64`,
    );
  }
  if (osName === 'linux' && isMusl()) {
    fail('musl-based Linux (such as Alpine) is not supported; the tbx binaries need glibc');
  }
  return `tbx-${osName}-${arch}`;
}

function downloadBase() {
  const base = (process.env.TBX_DOWNLOAD_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`invalid TBX_DOWNLOAD_BASE: ${base}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('the download base must use https (http is allowed only for localhost)');
  }
  return base;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  const asset = assetName();
  const expected = pkg.tbxChecksums[asset];
  if (!expected) fail(`no checksum for ${asset} in this package`);
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
    const url = `${base}/tbx-cli-v${pkg.version}/${asset}`;
    let body;
    try {
      const res = await fetch(url);
      if (!res.ok) fail(`download failed: ${url} returned ${res.status}`);
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      fail(`download failed: ${url}: ${err.message}`);
    }
    if (sha256(body) !== expected) {
      fail(`checksum mismatch for ${asset}; refusing to run the download`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${asset}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, body, { mode: 0o755 });
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  const result = spawnSync(target, process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) fail(`could not run ${target}: ${result.error.message}`);
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

main();

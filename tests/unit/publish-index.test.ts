import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIndex } from '../../tbx/src/commands/build.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/publish-index.sh', import.meta.url));
const SHA_OLD = 'a'.repeat(64);
const SHA_NEW = 'b'.repeat(64);

describe('scripts/publish-index.sh', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tbx-publish-index-'));
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      TBX_INDEX_REMOTE: path.join(dir, 'remote.git'),
    };
    execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'remote.git')], { env });
    execFileSync('git', ['init', '-q', path.join(dir, 'work')], { env });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function publish(version: string, sha: string): void {
    const url = `https://github.com/o/r/releases/download/transcribe-v${version}/transcribe-${version}.tar.gz`;
    execFileSync(SCRIPT, ['transcribe', version, url, sha], { cwd: path.join(dir, 'work'), env });
  }

  it('writes an index that parseIndex accepts, with the newest version found first', () => {
    publish('0.1.0', SHA_OLD);
    publish('0.2.0', SHA_NEW);
    const text = execFileSync(
      'git',
      ['--git-dir', path.join(dir, 'remote.git'), 'show', 'release-index:index.json'],
      { env, encoding: 'utf8' },
    );

    const entries = parseIndex(text, 'release-index');

    expect(entries.map((entry) => entry.version)).toEqual(['0.2.0', '0.1.0']);
    expect(entries.find((entry) => entry.name === 'transcribe')).toEqual({
      name: 'transcribe',
      version: '0.2.0',
      artifact:
        'https://github.com/o/r/releases/download/transcribe-v0.2.0/transcribe-0.2.0.tar.gz',
      sha256: SHA_NEW,
    });
  });
});

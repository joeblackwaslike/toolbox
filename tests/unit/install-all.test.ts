import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolError } from '../../shared/ts/src/errors.ts';
import { createOutput } from '../../shared/ts/src/output.ts';
import { packTar, sha256 } from '../../tbx/src/archive.ts';
import { writeIndex } from '../../tbx/src/commands/build.ts';
import { install } from '../../tbx/src/commands/install.ts';
import type { TbxContext } from '../../tbx/src/context.ts';
import { layout, members, publish, sandbox } from '../helpers/release.ts';

const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function context(home: string, env: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: TbxContext = {
    root: home,
    ci: env.CI === '1',
    pathBinaries: () => Promise.resolve([]),
    home,
    env,
    json: true,
    out: createOutput({
      json: true,
      streams: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    }),
  };
  return { ctx, stdout, stderr };
}

function otherPlatform(): string {
  return process.platform === 'darwin' ? 'linux' : 'macos';
}

describe('tbx install all', () => {
  it('fails non-zero and names the tool when the install lock times out', async () => {
    const box = await sandbox();
    const index = await publish(box, '1.0.0');
    const lock = layout(box.home).lock;
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(
      lock,
      JSON.stringify({ pid: process.ppid, createdAt: new Date().toISOString() }),
    );
    const { ctx, stderr } = context(box.home);
    const error = await install(ctx, 'all', { index, lockTimeoutMs: 200 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 69 });
    expect(String(error)).toMatch(/install failed: hello/);
    expect(stderr.join('')).not.toMatch(/skipped hello/);
    expect(stderr.join('')).toMatch(/hello: another tbx install is running/);
  });

  it('still skips a tool that does not support this platform', async () => {
    const box = await sandbox();
    const parts = members('1.0.0');
    const manifest = parts[1];
    if (manifest === undefined) throw new Error('fixture has no tool.toml');
    parts[1] = {
      ...manifest,
      content: Buffer.from(
        manifest.content.toString().replace(/platforms = .*/, `platforms = ["${otherPlatform()}"]`),
      ),
    };
    const index = await publish(box, '1.0.0', parts);
    const { ctx, stdout, stderr } = context(box.home);
    await install(ctx, 'all', { index });
    expect(JSON.parse(stdout.join(''))).toEqual({ installed: [], skipped: ['hello'] });
    expect(stderr.join('')).toMatch(/skipped hello: hello does not support/);
  });

  it('installs a tool once at its newest version when the index lists release history', async () => {
    const box = await sandbox();
    const newBytes = packTar(members('2.0.0'));
    const newArtifact = 'hello-2.0.0.tar.gz';
    await writeFile(`${box.releases}/${newArtifact}`, newBytes);
    const index = await writeIndex(box.releases, [
      { name: 'hello', version: '2.0.0', artifact: newArtifact, sha256: sha256(newBytes) },
      { name: 'hello', version: '1.0.0', artifact: 'hello-1.0.0.tar.gz', sha256: 'f'.repeat(64) },
    ]);
    const { ctx, stdout } = context(box.home);
    await install(ctx, 'all', { index });
    expect(JSON.parse(stdout.join(''))).toEqual({
      installed: [{ name: 'hello', version: '2.0.0' }],
    });
  });

  it('fails when a unit validator is missing under CI=1', async () => {
    const box = await sandbox();
    const unit = '[unit]\nkind = "schedule"\ninterval = 60\nrunAtLoad = false\n';
    const index = await publish(box, '1.0.0', members('1.0.0', unit));
    const { ctx } = context(box.home, { CI: '1' });
    process.env.PATH = '';
    const error = await install(ctx, 'all', { index }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 69 });
    expect(String(error)).toMatch(/install failed: hello/);
  });
});

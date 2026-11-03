import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { createOutput } from '../../shared/ts/src/output.ts';
import { packTar, sha256 } from '../../tbx/src/archive.ts';
import { writeIndex } from '../../tbx/src/commands/build.ts';
import { install } from '../../tbx/src/commands/install.ts';
import { update } from '../../tbx/src/commands/update.ts';
import type { TbxContext } from '../../tbx/src/context.ts';
import { readState, recordOf, tbxPaths } from '../../tbx/src/state.ts';
import { members, publish, sandbox } from '../helpers/release.ts';

function context(home: string): TbxContext {
  return {
    root: home,
    ci: false,
    pathBinaries: () => Promise.resolve([]),
    home,
    env: {},
    json: true,
    out: createOutput({ json: true, streams: { stdout: () => 0, stderr: () => 0 } }),
  };
}

async function installedVersion(ctx: TbxContext): Promise<string | undefined> {
  return recordOf(await readState(tbxPaths(ctx.home, ctx.env)), 'hello')?.version;
}

async function setup(installed: string) {
  const box = await sandbox();
  const ctx = context(box.home);
  await install(ctx, 'hello', { index: await publish(box, installed) });
  return { box, ctx };
}

describe('tbx update', () => {
  it('installs a newer version and reports from/to', async () => {
    const { box, ctx } = await setup('0.1.0');
    const index = await publish(box, '0.2.0');
    expect(await update(ctx, { index })).toEqual([{ name: 'hello', from: '0.1.0', to: '0.2.0' }]);
    expect(await installedVersion(ctx)).toBe('0.2.0');
  });

  it('reports to: null when already current', async () => {
    const { box, ctx } = await setup('0.1.0');
    const index = await publish(box, '0.1.0');
    expect(await update(ctx, { index })).toEqual([{ name: 'hello', from: '0.1.0', to: null }]);
  });

  it('does not downgrade to an older index version', async () => {
    const { box, ctx } = await setup('0.1.0');
    const index = await publish(box, '0.0.9');
    expect(await update(ctx, { name: 'hello', index })).toEqual([
      { name: 'hello', from: '0.1.0', to: null },
    ]);
    expect(await installedVersion(ctx)).toBe('0.1.0');
  });

  it('orders numerically and ranks a pre-release below its release', async () => {
    const { box, ctx } = await setup('0.9.0');
    expect((await update(ctx, { index: await publish(box, '0.10.0') }))[0]?.to).toBe('0.10.0');
    const pre = await publish(box, '0.10.1-rc.1');
    expect((await update(ctx, { index: pre }))[0]?.to).toBe('0.10.1-rc.1');
    const release = await publish(box, '0.10.1');
    expect((await update(ctx, { index: release }))[0]?.to).toBe('0.10.1');
  });

  it('exits config for a tool that is not installed', async () => {
    const { box, ctx } = await setup('0.1.0');
    const index = await publish(box, '0.2.0');
    const error = await update(ctx, { name: 'unknown', index }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: ExitCode.config });
  });

  it('considers every installed tool when no name is given', async () => {
    const box = await sandbox();
    const ctx = context(box.home);
    const names = ['hello', 'world'];
    const release = async (version: string): Promise<string> => {
      const entries = await Promise.all(
        names.map(async (name) => {
          const bytes = packTar(members(version, '', name));
          const artifact = `${name}-${version}.tar.gz`;
          await writeFile(join(box.releases, artifact), bytes);
          return { name, version, artifact, sha256: sha256(bytes) };
        }),
      );
      return writeIndex(box.releases, entries);
    };
    await install(ctx, 'all', { index: await release('0.1.0') });
    const results = await update(ctx, { index: await release('0.2.0') });
    expect(results).toEqual([
      { name: 'hello', from: '0.1.0', to: '0.2.0' },
      { name: 'world', from: '0.1.0', to: '0.2.0' },
    ]);
    const state = await readState(tbxPaths(ctx.home, ctx.env));
    expect(names.map((name) => recordOf(state, name)?.version)).toEqual(['0.2.0', '0.2.0']);
  });
});

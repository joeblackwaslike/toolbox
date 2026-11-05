import { mkdtemp, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
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
import { type Sandbox, members, publish, sandbox } from '../helpers/release.ts';

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

  it('ignores build metadata when comparing versions', async () => {
    const { box, ctx } = await setup('1.0.0+build.1');
    expect((await update(ctx, { index: await publish(box, '1.0.1') }))[0]?.to).toBe('1.0.1');
  });

  it('treats differing build metadata on an equal core as current', async () => {
    const { box, ctx } = await setup('1.0.0+a');
    expect((await update(ctx, { index: await publish(box, '1.0.0+b') }))[0]?.to).toBe(null);
  });

  it('ranks a pre-release below its release regardless of metadata', async () => {
    const { box, ctx } = await setup('1.0.0-rc.1');
    expect((await update(ctx, { index: await publish(box, '1.0.0') }))[0]?.to).toBe('1.0.0');
  });

  it('compares numeric prerelease identifiers numerically, not lexically', async () => {
    const { box, ctx } = await setup('1.0.0-rc.2');
    expect((await update(ctx, { index: await publish(box, '1.0.0-rc.10') }))[0]?.to).toBe(
      '1.0.0-rc.10',
    );
  });

  it('compares prerelease identifiers beyond Number.MAX_SAFE_INTEGER without rounding', async () => {
    const { box, ctx } = await setup('1.0.0-9007199254740992');
    expect(
      (await update(ctx, { index: await publish(box, '1.0.0-9007199254740993') }))[0]?.to,
    ).toBe('1.0.0-9007199254740993');
  });

  it('compares core versions above the safe integer range without rounding', async () => {
    const { box, ctx } = await setup('9007199254740992.0.0');
    expect((await update(ctx, { index: await publish(box, '9007199254740993.0.0') }))[0]?.to).toBe(
      '9007199254740993.0.0',
    );
  });

  it('exits config for a tool that is not installed', async () => {
    const { box, ctx } = await setup('0.1.0');
    const index = await publish(box, '0.2.0');
    const error = await update(ctx, { name: 'unknown', index }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: ExitCode.config });
  });

  it('installs the exact version it compared even if the index rolls back before the artifact fetch', async () => {
    const { ctx } = await setup('1.0.0');
    const artifacts = new Map([
      ['2.0.0', packTar(members('2.0.0'))],
      ['1.0.0', packTar(members('1.0.0'))],
    ]);
    let hits = 0;
    const indexBody = (): string => {
      const version = hits === 0 ? '2.0.0' : '1.0.0';
      hits += 1;
      const bytes = artifacts.get(version) as Buffer;
      return JSON.stringify({
        tools: [{ name: 'hello', version, artifact: `/${version}.tar.gz`, sha256: sha256(bytes) }],
      });
    };
    const server: Server = createServer((req, res) => {
      if (req.url === '/index.json') {
        res.end(indexBody());
        return;
      }
      const artifact = req.url ? artifacts.get(req.url.replace(/^\/|\.tar\.gz$/g, '')) : undefined;
      if (artifact === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.end(artifact);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as AddressInfo;
      const index = `http://127.0.0.1:${port}/index.json`;
      expect(await update(ctx, { index })).toEqual([{ name: 'hello', from: '1.0.0', to: '2.0.0' }]);
      expect(await installedVersion(ctx)).toBe('2.0.0');
    } finally {
      server.close();
    }
  });

  it('never downgrades when two updates race for the install lock', async () => {
    const { box, ctx } = await setup('1.0.0');
    const index = await publish(box, '2.0.0');
    const second = context(box.home);
    const [a, b] = await Promise.all([update(ctx, { index }), update(second, { index })]);
    const outcomes = [a[0]?.to, b[0]?.to];
    expect(outcomes.every((to) => to === '2.0.0' || to === null)).toBe(true);
    expect(outcomes).toContain('2.0.0');
    expect(await installedVersion(ctx)).toBe('2.0.0');
  });

  it('ends at the newer version when a stale updater races in with an older index', async () => {
    const { box, ctx } = await setup('1.0.0');
    const second = context(box.home);
    const staleBox: Sandbox = { home: box.home, releases: await mkdtemp(join(tmpdir(), 'tbx-rel-')) };
    const newer = await publish(box, '3.0.0');
    const stale = await publish(staleBox, '2.0.0');
    // Whichever updater locks first installs its own (correctly newer-than-installed) version;
    // the under-lock recheck in `installLocked` is what stops the race from ending on 2.0.0.
    await Promise.all([update(ctx, { index: newer }), update(second, { index: stale })]);
    expect(await installedVersion(ctx)).toBe('3.0.0');
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

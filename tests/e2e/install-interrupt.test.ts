import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Sandbox,
  TOOL,
  exists,
  layout,
  members,
  publish,
  runBinary,
  sandbox,
} from '../helpers/release.ts';
import { REPO } from '../helpers/roots.ts';

const FAULTS = [
  ['after-extract', '1.0.0'],
  ['after-move', '1.0.0'],
  ['after-link', '2.0.0'],
  ['before-state', '2.0.0'],
] as const;

function tbx(box: Sandbox, args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bun', ['tbx/src/index.ts', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: box.home, ...extra },
  });
}

async function stateVersion(box: Sandbox): Promise<string | undefined> {
  const text = await readFile(layout(box.home).state, 'utf8');
  const state = JSON.parse(text) as { tools: Record<string, { version: string }> };
  return state.tools[TOOL]?.version;
}

describe('an interrupted install', () => {
  it('state file is never partially written (kill between steps)', async () => {
    for (const [fault, linked] of FAULTS) {
      const box = await sandbox();
      const paths = layout(box.home);
      expect(tbx(box, ['install', TOOL, '--index', await publish(box, '1.0.0')]).status).toBe(0);
      const update = await publish(box, '2.0.0');
      const killed = tbx(box, ['install', TOOL, '--index', update], { TBX_TEST_FAULT_AT: fault });
      expect({ fault, signal: killed.signal }).toEqual({ fault, signal: 'SIGKILL' });
      expect({ fault, version: await stateVersion(box) }).toEqual({ fault, version: '1.0.0' });
      expect({ fault, runs: runBinary(paths.link) }).toEqual({ fault, runs: `hello ${linked}` });
      expect(runBinary(join(paths.tools, '1.0.0', 'bin', TOOL))).toBe('hello 1.0.0');
      const rerun = tbx(box, ['install', TOOL, '--index', update]);
      expect({ fault, status: rerun.status, stderr: rerun.stderr }).toEqual({
        fault,
        status: 0,
        stderr: '',
      });
      expect(await stateVersion(box)).toBe('2.0.0');
      expect(runBinary(paths.link)).toBe('hello 2.0.0');
      expect(await exists(paths.lock)).toBe(false);
    }
  });

  it('a killed first install leaves no record and a rerun completes it', async () => {
    const box = await sandbox();
    const index = await publish(box, '1.0.0');
    expect(
      tbx(box, ['install', TOOL, '--index', index], { TBX_TEST_FAULT_AT: 'after-move' }).signal,
    ).toBe('SIGKILL');
    expect(await exists(layout(box.home).state)).toBe(false);
    expect(tbx(box, ['install', TOOL, '--index', index]).status).toBe(0);
    expect(await stateVersion(box)).toBe('1.0.0');
  });
});

describe('tbx <tool> dispatch', () => {
  it('runs the installed binary with the remaining argv and passes its exit code through', async () => {
    const box = await sandbox();
    const script = Buffer.from('#!/bin/sh\necho "args: $*"\nexit 3\n');
    const parts = members('1.0.0');
    parts[0] = { path: `bin/${TOOL}`, content: script, mode: 0o755 };
    expect(tbx(box, ['install', TOOL, '--index', await publish(box, '1.0.0', parts)]).status).toBe(
      0,
    );
    const result = tbx(box, [TOOL, '--json', 'a b']);
    expect(result.stdout).toBe('args: --json a b\n');
    expect(result.status).toBe(3);
  });

  it('exits 2 with a usage error for a name that is neither a command nor installed', async () => {
    const box = await sandbox();
    const result = tbx(box, ['nope']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown command 'nope'/);
  });
});

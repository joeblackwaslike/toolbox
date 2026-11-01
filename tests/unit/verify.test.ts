import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncGenerated } from '../../shared/ts/src/gen/index.ts';
import { loadManifest, parseManifest } from '../../shared/ts/src/manifest.ts';
import { VERIFY_STEPS, type VerifyStepName, stepsInOrder } from '../../tbx/src/commands/verify.ts';
import { createIsolatedEnv } from '../../tbx/src/isolated-env.ts';
import { type StepOutcome, unitTestEnv } from '../../tbx/src/verify-checks.ts';
import { driftStep, endToEndStep } from '../../tbx/src/verify-steps.ts';
import { fixtureRoot } from '../helpers/roots.ts';

const PASS: StepOutcome = { status: 'pass' };
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('stepsInOrder', () => {
  it('lists every step in VERIFY_STEPS order whatever order the outcomes were built in', () => {
    const outcomes = {
      units: { status: 'skipped', detail: 'no unit' },
      e2e: PASS,
      contract: PASS,
      drift: { status: 'fail', detail: 'x' },
      unit: PASS,
      lint: PASS,
    } satisfies Record<VerifyStepName, StepOutcome>;
    const steps = stepsInOrder(outcomes);
    expect(steps.map((step) => step.name)).toEqual([...VERIFY_STEPS]);
    expect(steps[2]).toEqual({ name: 'drift', status: 'fail', detail: 'x' });
  });

  it('does not compile when a step is missing', () => {
    // @ts-expect-error the units step is missing
    const missing: Record<VerifyStepName, StepOutcome> = {
      lint: PASS,
      unit: PASS,
      drift: PASS,
      contract: PASS,
      e2e: PASS,
    };
    expect(Object.keys(missing)).toHaveLength(5);
  });
});

async function generatedRoot(): Promise<string> {
  const root = await fixtureRoot();
  await mkdir(join(root, 'tools/other'), { recursive: true });
  await writeFile(
    join(root, 'tools/other/tool.toml'),
    'name = "other"\nsummary = "Other tool"\nlanguage = "sh"\nversion = "0.1.0"\nplatforms = ["macos", "linux"]\n',
  );
  await syncGenerated(root);
  return root;
}

async function demoDrift(root: string): Promise<StepOutcome> {
  const demo = await loadManifest(join(root, 'tools/demo/tool.toml'));
  return driftStep(root, demo, { kind: 'unsupported' });
}

describe('driftStep', () => {
  it.each(['docs/catalog.md', 'docs/llms.txt', 'tools/demo/README.md'])(
    'fails when %s is out of date',
    async (file) => {
      const root = await generatedRoot();
      await writeFile(join(root, file), `${await readFile(join(root, file), 'utf8')}edit\n`);
      const outcome = await demoDrift(root);
      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toContain(file);
    },
  );

  it('fails when a shared doc page is stale', async () => {
    const root = await generatedRoot();
    await mkdir(join(root, 'docs/shared/ts'), { recursive: true });
    await writeFile(join(root, 'docs/shared/ts/gone.md'), 'old\n');
    expect((await demoDrift(root)).detail).toContain('docs/shared/ts/gone.md');
  });

  it("passes when only another tool's generated files drifted", async () => {
    const root = await generatedRoot();
    await writeFile(join(root, 'tools/other/README.md'), 'hand edit\n');
    expect(await demoDrift(root)).toEqual({ status: 'pass' });
  });
});

describe('unitTestEnv', () => {
  it('drops credential variables and keeps PATH and the cache locations', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'ghp-test';
    process.env.MY_PASSWORD = 'pw';
    process.env.UV_CACHE_DIR = '/tmp/uv-cache';
    const isolated = await createIsolatedEnv();
    try {
      const env = await unitTestEnv(isolated.env);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.MY_PASSWORD).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.UV_CACHE_DIR).toBe('/tmp/uv-cache');
      expect(env.HOME).toBe(isolated.home);
    } finally {
      await isolated.cleanup();
    }
  });
});

describe('endToEndStep without uv', () => {
  it('fails the step with "uv not found" instead of rejecting', async () => {
    const m = parseManifest(
      'name = "fake"\nsummary = "Fake tool"\nlanguage = "py"\nversion = "0.1.0"\nplatforms = ["macos", "linux"]\n',
    );
    const isolated = await createIsolatedEnv();
    const root = await mkdtemp(join(tmpdir(), 'tbx-steps-'));
    try {
      await mkdir(join(root, 'tools/fake/tests/e2e'), { recursive: true });
      await writeFile(join(root, 'tools/fake/tests/e2e/test_fake.py'), 'def test_x():\n    pass\n');
      const link = join(isolated.home, 'fake');
      await writeFile(link, `#!/bin/sh\nprintf '"fake"\\n'\n`);
      await chmod(link, 0o755);
      process.env.PATH = '';
      const outcome = await endToEndStep(root, m, { link, isolated }, 5000);
      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toMatch(/uv not found/);
    } finally {
      await isolated.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

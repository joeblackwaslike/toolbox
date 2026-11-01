import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../shared/ts/src/manifest.ts';
import { createIsolatedEnv } from '../../tbx/src/isolated-env.ts';
import { endToEndStep } from '../../tbx/src/verify-steps.ts';

const MANIFEST = parseManifest(`
name = "fake"
summary = "Fake tool"
language = "sh"
version = "0.1.0"
platforms = ["macos", "linux"]
`);
const DEADLINE_MS = 2000;
const TEST_TIMEOUT_MS = 30_000;
const WELL_BEHAVED = `printf '"fake"\\n'`;

async function stepFor(body: string, bogusPython = false): ReturnType<typeof endToEndStep> {
  const isolated = await createIsolatedEnv();
  const root = await mkdtemp(join(tmpdir(), 'tbx-steps-'));
  try {
    const link = join(isolated.home, 'fake');
    await writeFile(link, `#!/bin/sh\n${body}\n`);
    await chmod(link, 0o755);
    if (bogusPython) {
      const python = join(isolated.env.PATH ?? '', 'python3');
      await rm(python);
      const fake = join(isolated.home, 'python3');
      await writeFile(fake, '#!/bin/sh\necho "OSError: out of pty devices" >&2\nexit 1\n');
      await chmod(fake, 0o755);
      await symlink(fake, python);
    }
    return await endToEndStep(root, MANIFEST, { link, isolated }, DEADLINE_MS);
  } finally {
    await isolated.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

describe('endToEndStep interactive run', () => {
  it(
    'passes a tool that runs and exits on a terminal',
    async () => {
      expect(await stepFor(WELL_BEHAVED)).toEqual({ status: 'pass' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails with "cannot start a pty" when the pty driver dies before the terminal exists',
    async () => {
      const outcome = await stepFor(WELL_BEHAVED, true);
      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toMatch(/cannot start a pty.*out of pty devices/s);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails when the tool cannot be executed on a terminal (exit 126 or 127)',
    async () => {
      const outcome = await stepFor(`if [ -t 0 ]; then exit 127; fi\n${WELL_BEHAVED}`);
      expect(outcome).toMatchObject({ status: 'fail' });
      expect(outcome.detail).toMatch(/interactive run .*exit 127/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still fails at the deadline for a tool that hangs when prompting',
    async () => {
      const outcome = await stepFor(`if [ -t 0 ]; then sleep 600; fi\n${WELL_BEHAVED}`);
      expect(outcome.detail).toMatch(/interactive run .*killed at the 2s deadline/);
    },
    TEST_TIMEOUT_MS,
  );
});

const WHEN_NON_INTERACTIVE = 'case " $* " in *" -y "*)';

describe('endToEndStep non-interactive run', () => {
  it(
    'fails when the tool is killed by a signal',
    async () => {
      const outcome = await stepFor(
        `${WHEN_NON_INTERACTIVE} kill -KILL $$ ;; esac\n${WELL_BEHAVED}`,
      );
      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toMatch(/non-interactive run .*killed by SIGKILL/);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([126, 127])(
    'fails when the tool exits %i (could not be executed)',
    async (code) => {
      const outcome = await stepFor(
        `${WHEN_NON_INTERACTIVE} exit ${code} ;; esac\n${WELL_BEHAVED}`,
      );
      expect(outcome.status).toBe('fail');
      expect(outcome.detail).toMatch(new RegExp(`non-interactive run .*exit ${code}`));
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2])(
    'passes a domain failure (exit %i with nothing on stdout)',
    async (code) => {
      const body = `${WHEN_NON_INTERACTIVE} echo nope >&2; exit ${code} ;; esac\n${WELL_BEHAVED}`;
      expect(await stepFor(body)).toEqual({ status: 'pass' });
    },
    TEST_TIMEOUT_MS,
  );
});

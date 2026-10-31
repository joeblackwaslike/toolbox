import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binariesOnPath } from '../../shared/ts/src/paths.ts';

describe('binariesOnPath', () => {
  it('lists the names in every PATH directory once and skips missing directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tbx-path-'));
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'a/git'), '');
    await writeFile(join(root, 'b/git'), '');
    await writeFile(join(root, 'b/jq'), '');
    const path = [join(root, 'a'), join(root, 'missing'), '', join(root, 'b')].join(delimiter);
    expect(await binariesOnPath(path)).toEqual(['git', 'jq']);
  });
});

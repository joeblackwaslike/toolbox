import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { runTbx } from '../../tbx/src/index.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE_PLEASE_VERSION = '17.11.2';

interface Config {
  'separate-pull-requests': boolean;
  'bootstrap-sha': string;
  packages: Record<
    string,
    {
      component: string;
      'release-type': string;
      'extra-files'?: { type: string; path: string; jsonpath: string }[];
    }
  >;
}

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(`${ROOT}${file}`, 'utf8')) as T;
}

async function toolVersions(): Promise<Record<string, string>> {
  const names = await readdir(`${ROOT}tools`);
  const versions: Record<string, string> = {};
  for (const name of names) {
    const text = await readFile(`${ROOT}tools/${name}/tool.toml`, 'utf8').catch(() => undefined);
    if (text !== undefined) versions[name] = String(parse(text).version);
  }
  return versions;
}

describe(`release-please ${RELEASE_PLEASE_VERSION} config`, () => {
  it('opens one pull request per package', async () => {
    const config = await json<Config>('release-please-config.json');
    expect(config['separate-pull-requests']).toBe(true);
    expect(config['bootstrap-sha']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('configures tbx as tbx-cli with a version.txt', async () => {
    const config = await json<Config>('release-please-config.json');
    const manifest = await json<Record<string, string>>('.release-please-manifest.json');
    expect(config.packages.tbx).toMatchObject({ component: 'tbx-cli', 'release-type': 'simple' });
    expect(manifest.tbx).toBe('0.1.0');
  });

  it('configures every tool with its tool.toml version', async () => {
    const config = await json<Config>('release-please-config.json');
    const manifest = await json<Record<string, string>>('.release-please-manifest.json');
    const versions = await toolVersions();
    expect(Object.keys(versions).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(versions)) {
      expect(config.packages[`tools/${name}`]).toMatchObject({
        component: name,
        'release-type': 'simple',
        'extra-files': [{ type: 'toml', path: 'tool.toml', jsonpath: '$.version' }],
      });
      expect(manifest[`tools/${name}`]).toBe(version);
    }
  });

  it('has no packages beyond tbx and the tools, and unique components', async () => {
    const config = await json<Config>('release-please-config.json');
    const versions = await toolVersions();
    const expected = ['tbx', ...Object.keys(versions).map((name) => `tools/${name}`)];
    expect(Object.keys(config.packages).sort()).toEqual(expected.sort());
    const components = Object.values(config.packages).map((entry) => entry.component);
    expect(new Set(components).size).toBe(components.length);
  });
});

describe('tbx --version', () => {
  it('prints the contents of tbx/version.txt', async () => {
    const expected = (await readFile(`${ROOT}tbx/version.txt`, 'utf8')).trim();
    const result = await runTbx(['--version'], { root: ROOT });
    expect(result.stdout.trim()).toBe(expected);
    expect(result.code).toBe(0);
  });
});

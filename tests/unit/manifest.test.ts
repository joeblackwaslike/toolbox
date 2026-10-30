import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  assertNoCollisions,
  loadManifest,
  parseManifest,
} from '../../shared/ts/src/manifest.ts';

const VALID = `
name = "gen"
alias = "g"
summary = "Generate things"
language = "ts"
version = "1.2.3"
platforms = ["macos", "linux"]

[[args]]
name = "target"
summary = "What to generate"
required = true

[[options]]
long = "force"
short = "f"
summary = "Overwrite"
type = "bool"
default = false

[unit]
kind = "schedule"
runAtLoad = false
[unit.calendar]
hour = 3
minute = 30
`;

function withName(toml: string, name: string): string {
  return toml.replace('name = "gen"', `name = "${name}"`);
}

function manifest(name: string, alias?: string): ReturnType<typeof parseManifest> {
  const base = parseManifest(withName(VALID, name));
  const { alias: _drop, ...rest } = base;
  return alias === undefined ? rest : { ...rest, alias };
}

function fieldPathOf(toml: string): string | undefined {
  try {
    parseManifest(toml);
  } catch (error) {
    if (error instanceof ManifestError) return error.fieldPath;
    throw error;
  }
  return undefined;
}

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest(VALID);
    expect(m.name).toBe('gen');
    expect(m.alias).toBe('g');
    expect(m.platforms).toEqual(['macos', 'linux']);
    expect(m.args).toEqual([{ name: 'target', summary: 'What to generate', required: true }]);
    expect(m.options[0]?.long).toBe('force');
    expect(m.unit?.calendar).toEqual({ hour: 3, minute: 30 });
  });

  it('defaults args and options to empty arrays', () => {
    const toml = VALID.split('[[args]]')[0] ?? '';
    const m = parseManifest(toml);
    expect(m.args).toEqual([]);
    expect(m.options).toEqual([]);
    expect(m.unit).toBeUndefined();
  });

  it('rejects a name over 16 characters', () => {
    expect(() => parseManifest(withName(VALID, 'a'.repeat(17)))).toThrow(ManifestError);
    expect(() => parseManifest(withName(VALID, 'a'.repeat(17)))).toThrow(/name/);
  });

  it('rejects an unknown language', () => {
    const toml = VALID.replace('language = "ts"', 'language = "rb"');
    expect(() => parseManifest(toml)).toThrow(/language/);
  });

  it('rejects a schedule unit without calendar or interval', () => {
    const toml = VALID.replace(/\[unit\.calendar\][\s\S]*$/, '');
    expect(() => parseManifest(toml)).toThrow(ManifestError);
    expect(() => parseManifest(toml)).toThrow(/unit/);
  });

  it('rejects unknown keys', () => {
    expect(() => parseManifest(`${VALID}\nbogus = 1\n`)).toThrow(/bogus/);
    expect(fieldPathOf(`bogus = 1\n${VALID}`)).toBe('bogus');
  });

  it('names a nested unknown key in fieldPath', () => {
    const toml = VALID.replace('summary = "Overwrite"', 'summary = "Overwrite"\nbogus = 1');
    expect(fieldPathOf(toml)).toBe('options.0.bogus');
  });

  it('accepts an option long name over 16 characters', () => {
    const toml = VALID.replace('long = "force"', 'long = "force-overwrite-everything"');
    expect(parseManifest(toml).options[0]?.long).toBe('force-overwrite-everything');
  });

  it('rejects an option that redefines a built-in flag', () => {
    expect(fieldPathOf(VALID.replace('long = "force"', 'long = "json"'))).toBe('options.0.long');
    expect(fieldPathOf(VALID.replace('long = "force"', 'long = "no-input"'))).toBe(
      'options.0.long',
    );
    expect(fieldPathOf(VALID.replace('short = "f"', 'short = "y"'))).toBe('options.0.short');
    expect(fieldPathOf(VALID.replace('short = "f"', 'short = "h"'))).toBe('options.0.short');
  });

  it('rejects the positive form of a no- built-in flag', () => {
    expect(fieldPathOf(VALID.replace('long = "force"', 'long = "input"'))).toBe('options.0.long');
  });

  it('rejects an option long name with a no- prefix', () => {
    expect(fieldPathOf(VALID.replace('long = "force"', 'long = "no-color"'))).toBe(
      'options.0.long',
    );
  });

  it('rejects an argument name that is not a lowercase identifier', () => {
    expect(fieldPathOf(VALID.replace('name = "target"', 'name = "My File"'))).toBe('args.0.name');
  });

  it('rejects a version with a leading zero', () => {
    expect(fieldPathOf(VALID.replace('version = "1.2.3"', 'version = "01.2.3"'))).toBe('version');
  });

  it('accepts a semver prerelease with build metadata', () => {
    const toml = VALID.replace('version = "1.2.3"', 'version = "1.0.0-rc.1+build.5"');
    expect(parseManifest(toml).version).toBe('1.0.0-rc.1+build.5');
  });

  it('rejects empty platforms and a summary over 80 characters', () => {
    expect(() => parseManifest(VALID.replace('["macos", "linux"]', '[]'))).toThrow(/platforms/);
    expect(() => parseManifest(VALID.replace('Generate things', 'x'.repeat(81)))).toThrow(
      /summary/,
    );
  });

  it('rejects an alias equal to its own name', () => {
    expect(() => parseManifest(VALID.replace('alias = "g"', 'alias = "gen"'))).toThrow(/alias/);
  });

  it('wraps TOML syntax errors in ManifestError', () => {
    expect(() => parseManifest('name = ')).toThrow(ManifestError);
  });
});

describe('loadManifest', () => {
  it('reads and parses a file, and names the path on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-manifest-'));
    const good = join(dir, 'tool.toml');
    await writeFile(good, VALID);
    expect((await loadManifest(good)).name).toBe('gen');

    const bad = join(dir, 'bad.toml');
    await writeFile(bad, 'name = "X"');
    await expect(loadManifest(bad)).rejects.toThrow(bad);
    await expect(loadManifest(join(dir, 'missing.toml'))).rejects.toThrow(ManifestError);
  });
});

describe('assertNoCollisions', () => {
  it('passes for distinct names and aliases', () => {
    expect(() => {
      assertNoCollisions([manifest('gen', 'g'), manifest('new', 'n')], ['ls']);
    }).not.toThrow();
  });

  it("throws when an alias equals another tool's name", () => {
    expect(() => {
      assertNoCollisions([manifest('gen', 'new'), manifest('new')], []);
    }).toThrow(/gen.*new|new.*gen/);
  });

  it('throws when two aliases are equal', () => {
    expect(() => {
      assertNoCollisions([manifest('gen', 'x'), manifest('new', 'x')], []);
    }).toThrow(ManifestError);
  });

  it('throws when a name equals a binary already on PATH', () => {
    expect(() => {
      assertNoCollisions([manifest('gen')], ['gen']);
    }).toThrow(/PATH binary/);
  });

  it('throws when an alias equals a binary already on PATH', () => {
    expect(() => {
      assertNoCollisions([manifest('gen', 'ls')], ['ls']);
    }).toThrow(/PATH binary/);
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  RESERVED_COMMANDS,
  assertNoCollisions,
  loadManifest,
  parseManifest,
} from '../../shared/ts/src/manifest.ts';

const VALID = `
name = "forge"
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
  return toml.replace('name = "forge"', `name = "${name}"`);
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
    expect(m.name).toBe('forge');
    expect(m.alias).toBe('g');
    expect(m.platforms).toEqual(['macos', 'linux']);
    expect(m.args).toEqual([{ name: 'target', summary: 'What to generate', required: true }]);
    expect(m.options[0]?.long).toBe('force');
    expect(m.unit?.calendar).toEqual({ hour: 3, minute: 30 });
  });

  it('rejects a bool option that defaults to true', () => {
    const toml = `${VALID}
[[options]]
long = "color"
summary = "Colorize"
type = "bool"
default = true
`;
    expect(() => parseManifest(toml)).toThrow(/bool option cannot default to true/);
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

  it('rejects a daemon unit that sets calendar or interval', () => {
    const daemonWithCalendar = VALID.replace('kind = "schedule"', 'kind = "daemon"');
    expect(() => parseManifest(daemonWithCalendar)).toThrow(/daemon.*calendar/s);

    const daemonWithInterval = VALID.replace('kind = "schedule"', 'kind = "daemon"')
      .replace(/\[unit\.calendar\][\s\S]*$/, '')
      .replace('runAtLoad', 'interval = 60\nrunAtLoad');
    expect(() => parseManifest(daemonWithInterval)).toThrow(/daemon.*interval/s);
  });

  it('accepts a daemon unit with only runAtLoad', () => {
    const toml = VALID.replace('kind = "schedule"', 'kind = "daemon"').replace(
      /\[unit\.calendar\][\s\S]*$/,
      '',
    );
    expect(parseManifest(toml).unit).toEqual({ kind: 'daemon', runAtLoad: false });
  });

  it('rejects out-of-range or non-integer unit calendar and interval values', () => {
    for (const bad of ['hour = 24', 'hour = -1', 'hour = 3.5', 'minute = 60', 'minute = 1.5']) {
      const key = bad.split(' ')[0] as string;
      const toml = VALID.replace(new RegExp(`${key} = \\S+`), bad);
      expect(() => parseManifest(toml), bad).toThrow(ManifestError);
    }
    const interval = VALID.replace(/\[unit\.calendar\][\s\S]*$/, '').replace(
      'runAtLoad',
      'interval = 0\nrunAtLoad',
    );
    expect(() => parseManifest(interval)).toThrow(/interval/);
    expect(() => parseManifest(interval.replace('interval = 0', 'interval = 1.5'))).toThrow(
      /interval/,
    );
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
    expect(() => parseManifest(VALID.replace('alias = "g"', 'alias = "forge"'))).toThrow(/alias/);
  });

  it('wraps TOML syntax errors in ManifestError', () => {
    expect(() => parseManifest('name = ')).toThrow(ManifestError);
  });

  it.each([...RESERVED_COMMANDS])('rejects the tbx subcommand %s as a name or an alias', (word) => {
    expect(fieldPathOf(withName(VALID, word))).toBe('name');
    expect(fieldPathOf(VALID.replace('alias = "g"', `alias = "${word}"`))).toBe('alias');
  });

  it.each(['9007199254740992', '-9007199254740992'])('rejects the int default %s', (value) => {
    const toml = `${VALID}\n[[options]]\nlong = "count"\nsummary = "Passes"\ntype = "int"\ndefault = ${value}\n`;
    expect(() => parseManifest(toml)).toThrow(ManifestError);
  });

  it('accepts the largest safe int default', () => {
    const toml = `${VALID}\n[[options]]\nlong = "count"\nsummary = "Passes"\ntype = "int"\ndefault = 9007199254740991\n`;
    expect(parseManifest(toml).options[1]?.default).toBe(9_007_199_254_740_991);
  });

  it('rejects two options with the same long name', () => {
    const toml = `${VALID}\n[[options]]\nlong = "force"\nsummary = "Again"\ntype = "bool"\n`;
    expect(() => parseManifest(toml)).toThrow(/options\.1\.long.*duplicate/);
  });

  it('rejects two options with the same short name', () => {
    const toml = `${VALID}\n[[options]]\nlong = "fast"\nshort = "f"\nsummary = "Fast"\ntype = "bool"\n`;
    expect(() => parseManifest(toml)).toThrow(/options\.1\.short.*duplicate/);
  });

  it('rejects two arguments with the same name', () => {
    const toml = VALID.replace(
      '[[options]]',
      '[[args]]\nname = "target"\nsummary = "Again"\nrequired = false\n\n[[options]]',
    );
    expect(() => parseManifest(toml)).toThrow(/args\.1\.name.*duplicate/);
  });

  it.each(['foo--bar', 'foo-', 'foo-bar-', 'foo--'])('rejects the option name %s', (long) => {
    expect(fieldPathOf(VALID.replace('long = "force"', `long = "${long}"`))).toBe('options.0.long');
  });

  it.each(['foo--bar', 'foo-'])('rejects the argument name %s', (name) => {
    expect(fieldPathOf(VALID.replace('name = "target"', `name = "${name}"`))).toBe('args.0.name');
  });

  it('rejects two options whose names normalize to the same identifier', () => {
    const toml = VALID.replace('long = "force"', 'long = "foo1"').concat(
      '\n[[options]]\nlong = "foo-1"\nsummary = "Other"\ntype = "string"\n',
    );
    expect(() => parseManifest(toml)).toThrow(/options\.1\.long.*"foo-1".*"foo1"/);
  });

  it('rejects an argument and an option whose names normalize to the same identifier', () => {
    const toml = VALID.replace('name = "target"', 'name = "dry1"').replace(
      'long = "force"',
      'long = "dry-1"',
    );
    expect(() => parseManifest(toml)).toThrow(/"dry-1".*"dry1"/);
  });

  it('accepts ordinary hyphenated names with digit segments', () => {
    const toml = VALID.replace('long = "force"', 'long = "max-2-retries"').replace(
      'name = "target"',
      'name = "out-dir"',
    );
    expect(parseManifest(toml).options[0]?.long).toBe('max-2-retries');
  });

  it('rejects an argument and an option with the same name', () => {
    const toml = VALID.replace('name = "target"', 'name = "force"');
    expect(() => parseManifest(toml)).toThrow(/duplicate/);
  });

  it.each([
    ['an argument summary', 'summary = "What to generate"', 'summary = "What\\nto generate"'],
    ['an option summary', 'summary = "Overwrite"', 'summary = "Over\\u001bwrite"'],
    ['the tool summary', 'summary = "Generate things"', 'summary = "Generate\\tthings"'],
  ])('rejects a control character in %s', (_label, from, to) => {
    expect(() => parseManifest(VALID.replace(from, to))).toThrow(/control character/);
  });

  it('rejects an argument or option summary over 200 characters', () => {
    const long = 'x'.repeat(201);
    expect(() => parseManifest(VALID.replace('"What to generate"', `"${long}"`))).toThrow(
      ManifestError,
    );
    expect(() => parseManifest(VALID.replace('"Overwrite"', `"${long}"`))).toThrow(ManifestError);
    expect(
      parseManifest(VALID.replace('"Overwrite"', `"${'x'.repeat(200)}"`)).options,
    ).toHaveLength(1);
  });
});

describe('loadManifest', () => {
  it('reads and parses a file, and names the path on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-manifest-'));
    const good = join(dir, 'tool.toml');
    await writeFile(good, VALID);
    expect((await loadManifest(good)).name).toBe('forge');

    const bad = join(dir, 'bad.toml');
    await writeFile(bad, 'name = "X"');
    await expect(loadManifest(bad)).rejects.toThrow(bad);
    await expect(loadManifest(join(dir, 'missing.toml'))).rejects.toThrow(ManifestError);
  });

  it('keeps the read error as the cause and exposes its errno code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbx-manifest-'));
    const error = await loadManifest(join(dir, 'missing.toml')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).code).toBe('ENOENT');
    expect((error as ManifestError).cause).toBeInstanceOf(Error);
    await writeFile(join(dir, 'bad.toml'), 'name = "X"');
    const invalid = await loadManifest(join(dir, 'bad.toml')).catch((caught: unknown) => caught);
    expect((invalid as ManifestError).code).toBeUndefined();
  });
});

describe('assertNoCollisions', () => {
  it('passes for distinct names and aliases', () => {
    expect(() => {
      assertNoCollisions([manifest('forge', 'g'), manifest('mint', 'n')], ['ls']);
    }).not.toThrow();
  });

  it("throws when an alias equals another tool's name", () => {
    expect(() => {
      assertNoCollisions([manifest('forge', 'mint'), manifest('mint')], []);
    }).toThrow(/forge.*mint|mint.*forge/);
  });

  it('throws when two aliases are equal', () => {
    expect(() => {
      assertNoCollisions([manifest('forge', 'x'), manifest('mint', 'x')], []);
    }).toThrow(ManifestError);
  });

  it('throws when a name equals a binary already on PATH', () => {
    expect(() => {
      assertNoCollisions([manifest('forge')], ['forge']);
    }).toThrow(/PATH binary/);
  });

  it('throws when an alias equals a binary already on PATH', () => {
    expect(() => {
      assertNoCollisions([manifest('forge', 'ls')], ['ls']);
    }).toThrow(/PATH binary/);
  });
});

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderSystemdTimer,
  renderUnit,
  unitLabel,
  validateUnit,
} from '../../shared/ts/src/gen/unit.ts';
import { type ToolManifest, parseManifest } from '../../shared/ts/src/manifest.ts';

const HAS_PLUTIL = spawnSync('plutil', ['-help']).error === undefined;
const HAS_ANALYZE = spawnSync('systemd-analyze', ['--version']).error === undefined;

function manifest(unit: string, summary = 'Demo tool'): ToolManifest {
  return parseManifest(`
name = "demo"
summary = "${summary}"
language = "ts"
version = "0.1.0"
platforms = ["macos", "linux"]

[unit]
${unit}
`);
}

const SCHEDULE = manifest(
  'kind = "schedule"\nrunAtLoad = false\ncalendar = { hour = 3, minute = 30 }',
);
const INTERVAL = manifest('kind = "schedule"\ninterval = 900\nrunAtLoad = true');
const DAEMON = manifest('kind = "daemon"\nrunAtLoad = true');

const CTX = { binPath: '/home/joe/.local/bin/demo', home: '/home/joe', label: 'dev.tbx.demo' };
const UNICODE_HOME = '/Users/jöe black/ünï';
const UNICODE_CTX = {
  binPath: `${UNICODE_HOME}/.local/bin/demo`,
  home: UNICODE_HOME,
  label: 'dev.tbx.demo',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unitLabel', () => {
  it('prefixes the tool name with dev.tbx.', () => {
    expect(unitLabel(SCHEDULE)).toBe('dev.tbx.demo');
  });
});

describe('launchd rendering', () => {
  it('launchd plist contains StartCalendarInterval for a schedule unit', () => {
    const plist = renderUnit(SCHEDULE, 'launchd', CTX);
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<key>Hour</key>\n\t\t<integer>3</integer>');
    expect(plist).toContain('<key>Minute</key>\n\t\t<integer>30</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<false/>');
  });

  it('uses StartInterval for an interval schedule and KeepAlive for a daemon', () => {
    expect(renderUnit(INTERVAL, 'launchd', CTX)).toContain(
      '<key>StartInterval</key>\n\t<integer>900</integer>',
    );
    const daemon = renderUnit(DAEMON, 'launchd', CTX);
    expect(daemon).toContain('<key>KeepAlive</key>\n\t<true/>');
    expect(daemon).not.toContain('StartCalendarInterval');
  });

  it('puts the absolute binPath in ProgramArguments and logs under home', () => {
    const plist = renderUnit(SCHEDULE, 'launchd', CTX);
    expect(plist).toContain('<string>/home/joe/.local/bin/demo</string>');
    expect(plist).toContain('<string>/home/joe/Library/Logs/demo.log</string>');
  });

  it('is deterministic', () => {
    expect(renderUnit(SCHEDULE, 'launchd', CTX)).toBe(renderUnit(SCHEDULE, 'launchd', CTX));
  });

  it('escapes XML metacharacters in every interpolated value', () => {
    const plist = renderUnit(SCHEDULE, 'launchd', {
      binPath: `/b/<&>"'/demo`,
      home: '/h/<&>',
      label: 'a&b<c>',
    });
    expect(plist).toContain('<string>/b/&lt;&amp;&gt;&quot;&apos;/demo</string>');
    expect(plist).toContain('<string>/h/&lt;&amp;&gt;/Library/Logs/demo.log</string>');
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;</string>');
  });

  it('rejects control characters such as newlines', () => {
    expect(() => renderUnit(SCHEDULE, 'launchd', { ...CTX, binPath: '/a\n/b' })).toThrow(
      /control character/,
    );
    expect(() => renderUnit(SCHEDULE, 'systemd', { ...CTX, home: '/a\n/b' })).toThrow(
      /control character/,
    );
  });

  it('rejects a manifest without a unit or without the platform', () => {
    const noUnit = parseManifest(
      'name = "demo"\nsummary = "x"\nlanguage = "ts"\nversion = "0.1.0"\nplatforms = ["macos"]\n',
    );
    expect(() => renderUnit(noUnit, 'launchd', CTX)).toThrow(/no \[unit\]/);
    const linuxOnly = parseManifest(
      'name = "demo"\nsummary = "x"\nlanguage = "ts"\nversion = "0.1.0"\nplatforms = ["linux"]\n[unit]\nkind = "daemon"\nrunAtLoad = true\n',
    );
    expect(() => renderUnit(linuxOnly, 'launchd', CTX)).toThrow(/macos/);
  });
});

describe('systemd rendering', () => {
  it('systemd unit uses the absolute binPath', () => {
    const service = renderUnit(SCHEDULE, 'systemd', CTX);
    expect(service).toContain('ExecStart="/home/joe/.local/bin/demo"');
    expect(service).toContain('Type=oneshot');
  });

  it('daemon service restarts and installs into default.target', () => {
    const service = renderUnit(DAEMON, 'systemd', CTX);
    expect(service).toContain('Type=simple');
    expect(service).toContain('Restart=on-failure');
    expect(service).toContain('WantedBy=default.target');
  });

  it('quotes backslashes, quotes, dollars and percent specifiers in ExecStart', () => {
    const service = renderUnit(SCHEDULE, 'systemd', {
      ...CTX,
      binPath: String.raw`/a b/"q"/\x/%h/$HOME/demo`,
    });
    expect(service).toContain(String.raw`ExecStart="/a b/\"q\"/\\x/%%h/$$HOME/demo"`);
  });

  it('escapes percent specifiers in the description', () => {
    const m = manifest('kind = "daemon"\nrunAtLoad = true', '100% done');
    expect(renderUnit(m, 'systemd', CTX)).toContain('Description=100%% done');
  });

  it('renders a timer with OnCalendar for a calendar schedule', () => {
    const timer = renderSystemdTimer(SCHEDULE, CTX);
    expect(timer).toContain('OnCalendar=*-*-* 03:30:00');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
    expect(timer).not.toContain('OnActiveSec');
  });

  it('renders interval timers and fires immediately when runAtLoad is set', () => {
    const timer = renderSystemdTimer(INTERVAL, CTX);
    expect(timer).toContain('OnUnitActiveSec=900s');
    expect(timer).toContain('OnActiveSec=0');
  });

  it('starts the interval clock one interval after activation when runAtLoad is false', () => {
    const timer = renderSystemdTimer(
      manifest('kind = "schedule"\ninterval = 900\nrunAtLoad = false'),
      CTX,
    );
    expect(timer).toContain('OnActiveSec=900s');
    expect(timer).toContain('OnUnitActiveSec=900s');
  });

  it('refuses a timer for a daemon', () => {
    expect(() => renderSystemdTimer(DAEMON, CTX)).toThrow(/schedule/);
  });
});

describe('paths with spaces and non-ASCII characters', () => {
  it('renders correctly when home contains spaces and non-ASCII characters', () => {
    const plist = renderUnit(SCHEDULE, 'launchd', UNICODE_CTX);
    expect(plist).toContain(`<string>${UNICODE_HOME}/.local/bin/demo</string>`);
    expect(plist).toContain(`<string>${UNICODE_HOME}/Library/Logs/demo.log</string>`);
    const service = renderUnit(SCHEDULE, 'systemd', UNICODE_CTX);
    expect(service).toContain(`ExecStart="${UNICODE_HOME}/.local/bin/demo"`);
  });

  it.skipIf(!HAS_PLUTIL)('validates the unicode launchd plist with plutil', async () => {
    const result = await validateUnit('launchd', renderUnit(SCHEDULE, 'launchd', UNICODE_CTX));
    expect(result).toMatchObject({ ok: true, skipped: false });
  });

  it.skipIf(!HAS_ANALYZE)('validates the unicode systemd service', async () => {
    const result = await validateUnit('systemd', renderUnit(SCHEDULE, 'systemd', UNICODE_CTX));
    expect(result.skipped).toBe(false);
  });
});

describe('validateUnit', () => {
  it('validateUnit reports skipped when the validator is missing', async () => {
    vi.stubEnv('PATH', '/nonexistent-tbx-path');
    for (const kind of ['launchd', 'systemd'] as const) {
      const content = renderUnit(SCHEDULE, kind, CTX);
      const result = await validateUnit(kind, content);
      expect(result).toMatchObject({ ok: true, skipped: true });
      expect(result.message).toMatch(/not found/);
    }
  });

  it.skipIf(!HAS_PLUTIL)('accepts rendered plists for every unit shape', async () => {
    for (const m of [SCHEDULE, INTERVAL, DAEMON]) {
      const result = await validateUnit('launchd', renderUnit(m, 'launchd', CTX));
      expect(result).toMatchObject({ ok: true, skipped: false });
    }
  });

  it.skipIf(!HAS_PLUTIL)('accepts hostile values once escaped', async () => {
    const plist = renderUnit(SCHEDULE, 'launchd', {
      binPath: `/b/<&>"'%/demo`,
      home: '/h/<&>',
      label: 'a&b<c>',
    });
    expect(await validateUnit('launchd', plist)).toMatchObject({ ok: true, skipped: false });
  });

  it.skipIf(!HAS_PLUTIL)('rejects malformed plists', async () => {
    const result = await validateUnit('launchd', '<plist><dict>');
    expect(result).toMatchObject({ ok: false, skipped: false });
  });

  it.skipIf(!HAS_PLUTIL)('rejects wrong key types', async () => {
    const good = renderUnit(SCHEDULE, 'launchd', CTX);
    const noLabel = good.replace('<key>Label</key>', '<key>Lbl</key>');
    expect((await validateUnit('launchd', noLabel)).message).toMatch(/Label/);
    const badHour = good.replace('<integer>3</integer>', '<string>3</string>');
    expect((await validateUnit('launchd', badHour)).message).toMatch(/Hour/);
    const badRun = good.replace('<false/>', '<string>no</string>');
    expect((await validateUnit('launchd', badRun)).message).toMatch(/RunAtLoad/);
    const badArgs = good.replace(
      '<string>/home/joe/.local/bin/demo</string>',
      '<integer>1</integer>',
    );
    expect((await validateUnit('launchd', badArgs)).message).toMatch(/ProgramArguments/);
  });

  it.skipIf(!HAS_PLUTIL)('leaves no temp files behind', async () => {
    const before = spawnSync('sh', ['-c', 'ls "${TMPDIR:-/tmp}" | grep -c tbx-unit-'])
      .stdout.toString()
      .trim();
    await validateUnit('launchd', renderUnit(SCHEDULE, 'launchd', CTX));
    await validateUnit('launchd', '<plist><dict>');
    const after = spawnSync('sh', ['-c', 'ls "${TMPDIR:-/tmp}" | grep -c tbx-unit-'])
      .stdout.toString()
      .trim();
    expect(after).toBe(before);
  });
});

describe('validateUnit bounds', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it.each([
    ['launchd', 'plutil'],
    ['systemd', 'systemd-analyze'],
  ] as const)(
    'a %s validator that hangs fails at the limit instead of hanging',
    async (kind, tool) => {
      const dir = await mkdtemp(join(tmpdir(), 'tbx-slow-'));
      await writeFile(join(dir, tool), '#!/bin/sh\nsleep 10\n');
      await chmod(join(dir, tool), 0o755);
      process.env.PATH = [dir, originalPath ?? ''].join(delimiter);
      const started = Date.now();
      const result = await validateUnit(kind, 'not checked', 200);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result).toEqual({ ok: false, skipped: false, message: 'timed out after 0.2s' });
    },
  );
});

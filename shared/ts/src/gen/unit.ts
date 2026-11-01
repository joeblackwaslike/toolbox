import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isErrnoException } from '../errors.ts';
import type { ToolManifest, UnitSpec } from '../manifest.ts';
import { runBounded } from '../run.ts';

/** Longest a unit validator (`plutil`, `systemd-analyze`) may run before it counts as failed. */
export const VALIDATOR_TIMEOUT_MS = 30_000;

const LABEL_PREFIX = 'dev.tbx.';
const TEMP_PREFIX = 'tbx-unit-';

const PLATFORM_FOR_KIND = { launchd: 'macos', systemd: 'linux' } as const;
const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Service manager a unit file is rendered for. */
export type UnitKind = 'launchd' | 'systemd';

/**
 * Absolute, caller-supplied values interpolated into a unit. Nothing is read from the
 * environment, because launchd does not inherit a shell PATH.
 */
export interface UnitContext {
  /** Absolute path of the installed tool binary, used as the only program argument. */
  binPath: string;
  /** Absolute home directory; macOS logs go to `<home>/Library/Logs/<name>.log`. */
  home: string;
  /** Unit label, normally `unitLabel(manifest)`. */
  label: string;
}

/** Outcome of `validateUnit`. `skipped` is true when the validator binary is not installed. */
export interface UnitValidation {
  ok: boolean;
  skipped: boolean;
  message: string;
}

/** Returns the launchd label and systemd unit stem for a tool, `dev.tbx.<name>`. */
export function unitLabel(m: ToolManifest): string {
  return `${LABEL_PREFIX}${m.name}`;
}

function assertPrintable(field: string, value: string): void {
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} contains a control character`);
}

function unitOf(m: ToolManifest, kind: UnitKind, ctx: UnitContext): UnitSpec {
  if (m.unit === undefined) throw new Error(`${m.name} has no [unit] table`);
  const platform = PLATFORM_FOR_KIND[kind];
  if (!m.platforms.includes(platform)) {
    throw new Error(`${m.name} does not declare platform ${platform} required for ${kind}`);
  }
  assertPrintable('binPath', ctx.binPath);
  assertPrintable('home', ctx.home);
  assertPrintable('label', ctx.label);
  assertPrintable('summary', m.summary);
  return m.unit;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function xml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (char) => XML_ENTITIES[char] ?? char);
}

function plistEntry(key: string, value: string): string[] {
  return [`\t<key>${key}</key>`, `\t${value}`];
}

function plistStrings(items: string[]): string {
  return [
    '<array>',
    ...items.map((item) => `\t\t<string>${xml(item)}</string>`),
    '\t</array>',
  ].join('\n');
}

function launchd(m: ToolManifest, unit: UnitSpec, ctx: UnitContext): string {
  const log = `${ctx.home}/Library/Logs/${m.name}.log`;
  const calendar =
    unit.calendar === undefined
      ? []
      : plistEntry(
          'StartCalendarInterval',
          [
            '<dict>',
            '\t\t<key>Hour</key>',
            `\t\t<integer>${unit.calendar.hour}</integer>`,
            '\t\t<key>Minute</key>',
            `\t\t<integer>${unit.calendar.minute}</integer>`,
            '\t</dict>',
          ].join('\n'),
        );
  const interval =
    unit.interval === undefined
      ? []
      : plistEntry('StartInterval', `<integer>${unit.interval}</integer>`);
  const keepAlive = unit.kind === 'daemon' ? plistEntry('KeepAlive', '<true/>') : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...plistEntry('Label', `<string>${xml(ctx.label)}</string>`),
    ...plistEntry('ProgramArguments', plistStrings([ctx.binPath])),
    ...calendar,
    ...interval,
    ...keepAlive,
    ...plistEntry('RunAtLoad', unit.runAtLoad ? '<true/>' : '<false/>'),
    ...plistEntry('StandardOutPath', `<string>${xml(log)}</string>`),
    ...plistEntry('StandardErrorPath', `<string>${xml(log)}</string>`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', String.raw`\"`)
    .replaceAll('%', '%%')
    .replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

function systemdText(value: string): string {
  return value.replaceAll('%', '%%');
}

function systemd(m: ToolManifest, unit: UnitSpec, ctx: UnitContext): string {
  const isDaemon = unit.kind === 'daemon';
  return [
    '[Unit]',
    `Description=${systemdText(m.summary)}`,
    '',
    '[Service]',
    `Type=${isDaemon ? 'simple' : 'oneshot'}`,
    `ExecStart=${systemdQuote(ctx.binPath)}`,
    ...(isDaemon ? ['Restart=on-failure'] : []),
    ...(isDaemon ? ['', '[Install]', 'WantedBy=default.target'] : []),
    '',
  ].join('\n');
}

/**
 * Renders the unit file for a tool's `[unit]` table.
 *
 * launchd returns a user agent plist for `~/Library/LaunchAgents/<label>.plist`, logging to
 * `<home>/Library/Logs/<name>.log`. systemd returns the user service for
 * `~/.config/systemd/user/<label>.service`, logging to the journal. A systemd `schedule` unit
 * also needs the timer from `renderSystemdTimer`. Output is deterministic and every
 * interpolated value is escaped for its format. A daemon unit ignores `runAtLoad` for its
 * timing on both formats, because launchd KeepAlive and systemd Restart start it regardless.
 *
 * @throws {Error} when the manifest has no `[unit]`, lacks the matching platform, or a context
 * value contains a control character.
 */
export function renderUnit(m: ToolManifest, kind: UnitKind, ctx: UnitContext): string {
  const unit = unitOf(m, kind, ctx);
  return kind === 'launchd' ? launchd(m, unit, ctx) : systemd(m, unit, ctx);
}

function firstActivation(unit: UnitSpec): string[] {
  if (unit.runAtLoad) return ['OnActiveSec=0'];
  return unit.interval === undefined ? [] : [`OnActiveSec=${unit.interval}s`];
}

/**
 * Renders the `<label>.timer` that activates the service from `renderUnit(m, 'systemd', ctx)`
 * for a `schedule` unit.
 *
 * @throws {Error} when the unit is not a `schedule`, plus the errors of `renderUnit`.
 */
export function renderSystemdTimer(m: ToolManifest, ctx: UnitContext): string {
  const unit = unitOf(m, 'systemd', ctx);
  if (unit.kind !== 'schedule') throw new Error(`${m.name} is not a schedule unit, no timer`);
  return [
    '[Unit]',
    `Description=${systemdText(m.summary)} (timer)`,
    '',
    '[Timer]',
    ...(unit.calendar === undefined
      ? []
      : [`OnCalendar=*-*-* ${pad(unit.calendar.hour)}:${pad(unit.calendar.minute)}:00`]),
    ...(unit.interval === undefined ? [] : [`OnUnitActiveSec=${unit.interval}s`]),
    ...firstActivation(unit),
    ...(unit.calendar === undefined ? [] : ['Persistent=true']),
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function isMissing(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

function failure(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message: string };
  return (stderr ?? message).trim();
}

function isInt(value: unknown): boolean {
  return Number.isInteger(value);
}

function calendarProblem(calendar: unknown): string | null {
  if (typeof calendar !== 'object' || calendar === null || Array.isArray(calendar)) {
    return 'StartCalendarInterval must be a dict';
  }
  const { Hour, Minute } = calendar as Record<string, unknown>;
  if (!isInt(Hour)) return 'StartCalendarInterval Hour must be an integer';
  if (!isInt(Minute)) return 'StartCalendarInterval Minute must be an integer';
  return null;
}

function plistProblem(parsed: unknown): string | null {
  const plist = parsed as Record<string, unknown>;
  if (typeof plist.Label !== 'string') return 'Label must be a string';
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
    return 'ProgramArguments must be a non-empty array of strings';
  }
  if (plist.StartInterval !== undefined && !isInt(plist.StartInterval)) {
    return 'StartInterval must be an integer';
  }
  if (typeof plist.RunAtLoad !== 'boolean') return 'RunAtLoad must be a boolean';
  return plist.StartCalendarInterval === undefined
    ? null
    : calendarProblem(plist.StartCalendarInterval);
}

async function validateLaunchd(file: string, timeoutMs: number): Promise<UnitValidation> {
  try {
    await runBounded('plutil', ['-lint', file], { timeoutMs });
    const { stdout } = await runBounded('plutil', ['-convert', 'json', '-o', '-', file], {
      timeoutMs,
    });
    const problem = plistProblem(JSON.parse(stdout));
    return problem === null
      ? { ok: true, skipped: false, message: 'plist is valid' }
      : { ok: false, skipped: false, message: problem };
  } catch (error) {
    if (isMissing(error)) return { ok: true, skipped: true, message: 'plutil not found' };
    return { ok: false, skipped: false, message: failure(error) };
  }
}

async function validateSystemd(file: string, timeoutMs: number): Promise<UnitValidation> {
  try {
    await runBounded('systemd-analyze', ['verify', file], { timeoutMs });
    return { ok: true, skipped: false, message: 'unit is valid' };
  } catch (error) {
    if (isMissing(error)) {
      return { ok: true, skipped: true, message: 'systemd-analyze not found' };
    }
    return { ok: false, skipped: false, message: failure(error) };
  }
}

/**
 * Validates rendered unit text with the platform tool. launchd runs `plutil -lint` and then
 * checks the required keys and their types (Label, ProgramArguments, StartCalendarInterval
 * Hour/Minute, StartInterval, RunAtLoad); systemd runs `systemd-analyze verify` on a service
 * file. Returns `skipped: true` when the tool is not installed, and removes its temp files.
 * A validator still running after `timeoutMs` is killed and the unit counts as invalid, with
 * the message `timed out after <n>s`.
 */
export async function validateUnit(
  kind: UnitKind,
  content: string,
  timeoutMs: number = VALIDATOR_TIMEOUT_MS,
): Promise<UnitValidation> {
  const dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  try {
    const file = path.join(dir, kind === 'launchd' ? 'unit.plist' : 'unit.service');
    await writeFile(file, content, 'utf8');
    return await (kind === 'launchd'
      ? validateLaunchd(file, timeoutMs)
      : validateSystemd(file, timeoutMs));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

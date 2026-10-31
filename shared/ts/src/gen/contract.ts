import { type UsageOption, usageOf } from '../cli.ts';
import { ExitCode } from '../errors.ts';
import type { ToolManifest } from '../manifest.ts';

/** Value the contract cases pass for every positional argument and string option. */
export const CONTRACT_PLACEHOLDER = 'x';
const PLACEHOLDERS: Record<UsageOption['type'], string[]> = {
  bool: [],
  string: [CONTRACT_PLACEHOLDER],
  int: ['1'],
};
const UNKNOWN_FLAG = '--tbx-contract-unknown-flag';
const OVERLONG_DIGITS = 5000;

/** `int` option values every parser must accept: the safe-integer bounds and zero. */
export const INTEGER_ACCEPTED: readonly string[] = ['9007199254740991', '-9007199254740991', '0'];
/**
 * `int` option values every parser must reject with exit 2: one past each bound, a non-ASCII
 * digit, a `+` sign, exponent notation, a leading zero, surrounding whitespace and a
 * 5000-digit number (longer than Python's default int-conversion limit).
 */
export const INTEGER_REJECTED: readonly string[] = [
  '9007199254740992',
  '-9007199254740992',
  '\u0663',
  '+3',
  '1e3',
  '007',
  ' 3',
  '9'.repeat(OVERLONG_DIGITS),
];

/**
 * One interface check for a built tool: run it with `argv`, expect exit code `expectExit`,
 * and, when `expectStdout` is `'json'`, expect stdout to be a single valid JSON document.
 */
export interface ContractCase {
  name: string;
  argv: string[];
  expectExit: number;
  expectStdout?: 'json';
}

function optionCases(option: UsageOption): ContractCase[] {
  const forms = [`--${option.long}`, ...(option.short === null ? [] : [`-${option.short}`])];
  return forms.map((flag) => {
    if (option.long === 'help') {
      return { name: `option ${flag}`, argv: [flag], expectExit: ExitCode.ok };
    }
    const argv = [flag, ...PLACEHOLDERS[option.type], '--help'];
    const json = option.long === 'json' ? { expectStdout: 'json' as const } : {};
    return { name: `option ${flag}`, argv, expectExit: ExitCode.ok, ...json };
  });
}

function missingCases(m: ToolManifest): ContractCase[] {
  return m.args.flatMap((argument, index) => {
    if (!argument.required) return [];
    const before = m.args.slice(0, index).map(() => CONTRACT_PLACEHOLDER);
    return ['-y', '--json'].map((flag) => ({
      name: `missing ${argument.name} with ${flag}`,
      argv: [...before, flag],
      expectExit: ExitCode.usage,
    }));
  });
}

function integerCases(option: { long: string }): ContractCase[] {
  const flag = `--${option.long}`;
  return [
    { name: `non-integer ${flag}`, argv: [flag, 'many', '--help'], expectExit: ExitCode.usage },
    ...INTEGER_ACCEPTED.map((value) => ({
      name: `${flag} accepts ${value}`,
      argv: [flag, value, '--help'],
      expectExit: ExitCode.ok,
    })),
    ...INTEGER_REJECTED.map((value) => ({
      name: `${flag} rejects ${value}`,
      argv: [flag, value, '--help'],
      expectExit: ExitCode.usage,
    })),
  ];
}

/**
 * Generates the interface contract for a manifest: every documented option and short form
 * (including `-y`/`--no-input`, `--json` and `-h`/`--help`), each missing required argument
 * under `-y` and under `--json`, an unknown flag, too many arguments, and for each `int` option
 * a non-integer value plus every `INTEGER_ACCEPTED` and `INTEGER_REJECTED` value. Every case either fails parsing or ends at `--help`, so the tool
 * body never runs and the cases hold for any tool built from the manifest.
 */
export function generateContractTests(m: ToolManifest): ContractCase[] {
  const required = m.args.filter((argument) => argument.required).map(() => CONTRACT_PLACEHOLDER);
  const usageError = (name: string, argv: string[]): ContractCase => ({
    name,
    argv: [...argv, '--help'],
    expectExit: ExitCode.usage,
  });
  return [
    ...usageOf(m).options.flatMap((option) => optionCases(option)),
    ...missingCases(m),
    usageError('unknown flag', [...required, UNKNOWN_FLAG]),
    usageError('too many arguments', [
      ...m.args.map(() => CONTRACT_PLACEHOLDER),
      CONTRACT_PLACEHOLDER,
    ]),
    ...m.options
      .filter((option) => option.type === 'int')
      .flatMap((option) => integerCases(option)),
  ];
}

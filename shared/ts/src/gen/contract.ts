import { type UsageOption, usageOf } from '../cli.ts';
import { ExitCode } from '../errors.ts';
import type { ToolManifest } from '../manifest.ts';

const PLACEHOLDER = 'x';
const PLACEHOLDERS: Record<UsageOption['type'], string[]> = {
  bool: [],
  string: [PLACEHOLDER],
  int: ['1'],
};
const UNKNOWN_FLAG = '--tbx-contract-unknown-flag';

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
    const before = m.args.slice(0, index).map(() => PLACEHOLDER);
    return ['-y', '--json'].map((flag) => ({
      name: `missing ${argument.name} with ${flag}`,
      argv: [...before, flag],
      expectExit: ExitCode.usage,
    }));
  });
}

/**
 * Generates the interface contract for a manifest: every documented option and short form
 * (including `-y`/`--no-input`, `--json` and `-h`/`--help`), each missing required argument
 * under `-y` and under `--json`, an unknown flag, too many arguments and a non-integer value
 * for each `int` option. Every case either fails parsing or ends at `--help`, so the tool
 * body never runs and the cases hold for any tool built from the manifest.
 */
export function generateContractTests(m: ToolManifest): ContractCase[] {
  const required = m.args.filter((argument) => argument.required).map(() => PLACEHOLDER);
  const usageError = (name: string, argv: string[]): ContractCase => ({
    name,
    argv: [...argv, '--help'],
    expectExit: ExitCode.usage,
  });
  return [
    ...usageOf(m).options.flatMap((option) => optionCases(option)),
    ...missingCases(m),
    usageError('unknown flag', [...required, UNKNOWN_FLAG]),
    usageError('too many arguments', [...m.args.map(() => PLACEHOLDER), PLACEHOLDER]),
    ...m.options
      .filter((option) => option.type === 'int')
      .map((option) => usageError(`non-integer --${option.long}`, [`--${option.long}`, 'many'])),
  ];
}

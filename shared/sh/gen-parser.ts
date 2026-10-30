import { usageOf } from '../ts/src/cli.ts';
import type { OptSpec, ToolManifest } from '../ts/src/manifest.ts';

const HELP_GAP = 2;

const ESCAPED_QUOTE = String.raw`'\''`;

function shQuote(text: string): string {
  return `'${text.replaceAll("'", ESCAPED_QUOTE)}'`;
}

function variableName(prefix: 'ARG' | 'OPT', name: string): string {
  return `TBX_${prefix}_${name.toUpperCase().replaceAll('-', '_')}`;
}

function initialValue(spec: OptSpec): string {
  if (spec.type === 'bool') return spec.default === true ? '1' : '0';
  return spec.default === undefined ? "''" : shQuote(String(spec.default));
}

function assign(spec: OptSpec, value: string): string[] {
  const check = spec.type === 'int' ? [`_tbx_int --${spec.long} "${value}"`] : [];
  return [...check, `${variableName('OPT', spec.long)}=${value}`];
}

function caseArm(pattern: string, body: string[]): string[] {
  if (body.length === 1) return [`    ${pattern}) ${body[0] ?? ''} ;;`];
  return [`    ${pattern})`, ...body.map((line) => `      ${line}`), '      ;;'];
}

function optionArms(spec: OptSpec): string[] {
  const variable = variableName('OPT', spec.long);
  const flags = spec.short === undefined ? `--${spec.long}` : `-${spec.short} | --${spec.long}`;
  if (spec.type === 'bool') return caseArm(flags, [`${variable}=1`]);
  const separate = ['_tbx_value "$arg" $#', ...assign(spec, '$1'), 'shift'];
  const arms = [
    ...caseArm(flags, separate),
    ...caseArm(`--${spec.long}=*`, assign(spec, '${arg#*=}')),
  ];
  return spec.short === undefined
    ? arms
    : [...arms, ...caseArm(`-${spec.short}?*`, assign(spec, '${arg:2}'))];
}

function helpText(m: ToolManifest): string {
  const usage = usageOf(m);
  const argumentRows = usage.args.map((argument) => [argument.name, argument.summary]);
  const optionRows = usage.options.map((spec) => {
    const short = spec.short === null ? '    ' : `-${spec.short}, `;
    const value = spec.type === 'bool' ? '' : ` <${spec.long}>`;
    return [`${short}--${spec.long}${value}`, spec.summary];
  });
  const width = Math.max(...[...argumentRows, ...optionRows].map(([label = '']) => label.length));
  const render = (rows: string[][]): string[] =>
    rows.map(([label = '', summary = '']) => `  ${label.padEnd(width + HELP_GAP)}${summary}`);
  const sections = [`Usage: ${usage.usage}`, '', usage.summary, ''];
  const argumentSection =
    argumentRows.length > 0 ? ['Arguments:', ...render(argumentRows), ''] : [];
  return [...sections, ...argumentSection, 'Options:', ...render(optionRows), ''].join('\n');
}

function requiredChecks(m: ToolManifest): string[] {
  return m.args.flatMap((argument, index) =>
    argument.required
      ? [
          `  if ((\${#positionals[@]} < ${index + 1})); then`,
          `    _tbx_usage_error "missing required argument '${argument.name}'"`,
          '  fi',
        ]
      : [],
  );
}

function parseFunction(m: ToolManifest): string[] {
  return [
    '_tbx_parse() {',
    ...m.options.map((spec) => `  ${variableName('OPT', spec.long)}=${initialValue(spec)}`),
    '  TBX_NO_INPUT=0',
    '  TBX_JSON=0',
    '  local help=0 arg',
    '  local positionals=()',
    '  while (($# > 0)); do',
    '    arg=$1',
    '    shift',
    '    case $arg in',
    ...caseArm('--', ['positionals+=("$@")', 'break']),
    ...m.options.flatMap((spec) => optionArms(spec)),
    ...caseArm('-y | --no-input', ['TBX_NO_INPUT=1']),
    ...caseArm('--json', ['TBX_JSON=1']),
    ...caseArm('-h | --help', ['help=1']),
    ...caseArm('-[!-]?*', ['set -- "${arg:0:2}" "-${arg:2}" "$@"']),
    ...caseArm('-?*', [`_tbx_usage_error "unknown option '$arg'"`]),
    ...caseArm('*', ['positionals+=("$arg")']),
    '    esac',
    '  done',
    `  if ((\${#positionals[@]} > ${m.args.length})); then`,
    '    _tbx_usage_error "too many arguments"',
    '  fi',
    '  if ((help)); then',
    '    if ((TBX_JSON)); then',
    `      printf '%s\\n' "$_TBX_USAGE_JSON"`,
    '    else',
    `      printf '%s' "$_TBX_HELP"`,
    '    fi',
    '    exit 0',
    '  fi',
    ...requiredChecks(m),
    ...m.args.map(
      (argument, index) => `  ${variableName('ARG', argument.name)}=\${positionals[${index}]-}`,
    ),
    '  TBX_INTERACTIVE=0',
    '  if [[ -t 0 ]] && ((! TBX_NO_INPUT && ! TBX_JSON)); then',
    '    TBX_INTERACTIVE=1',
    '  fi',
    '}',
  ];
}

/**
 * Generates the bash prelude for a shell tool. Source `shared/sh/lib.sh`, then the prelude;
 * it turns on `set -euo pipefail` and parses `"$@"` into `TBX_ARG_<NAME>` and
 * `TBX_OPT_<LONG>` (bools are `1`/`0`, unset values are empty), sets `TBX_JSON`,
 * `TBX_NO_INPUT` and `TBX_INTERACTIVE`, handles `-h`/`--help` (as `usageOf(m)` JSON with
 * `--json`), and exits 2 with a usage line on bad input. It never reads stdin and runs on
 * bash 3.2.
 */
export function generateShellParser(m: ToolManifest): string {
  const usage = usageOf(m);
  return [
    '# shellcheck shell=bash disable=SC2016,SC2034',
    `# @file ${m.name} argument parser`,
    '# @brief Generated by tbx from tool.toml; do not edit.',
    '# @description',
    '#   Source shared/sh/lib.sh, then this file. It parses "$@" into TBX_ARG_* and TBX_OPT_*.',
    '',
    'set -euo pipefail',
    '',
    `_TBX_USAGE=${shQuote(usage.usage)}`,
    `_TBX_USAGE_JSON=${shQuote(JSON.stringify(usage))}`,
    `_TBX_HELP=${shQuote(helpText(m))}`,
    '',
    '_tbx_usage_error() {',
    '  tbx_error "error: $1"',
    '  tbx_error "Usage: $_TBX_USAGE"',
    '  exit 2',
    '}',
    '',
    '_tbx_value() {',
    `  (($2 > 0)) || _tbx_usage_error "option '$1' needs a value"`,
    '}',
    '',
    '_tbx_int() {',
    "  local pattern='^-?[0-9]+$'",
    `  [[ $2 =~ $pattern ]] || _tbx_usage_error "option '$1' must be an integer"`,
    '}',
    '',
    ...parseFunction(m),
    '',
    '_tbx_parse "$@"',
    '',
  ].join('\n');
}

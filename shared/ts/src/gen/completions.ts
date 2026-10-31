import { type UsageOption, usageOf } from '../cli.ts';
import type { ToolManifest } from '../manifest.ts';

/** Shells that get a generated completion file. */
export type CompletionShell = 'zsh' | 'bash' | 'fish';

function names(m: ToolManifest): string[] {
  return m.alias === undefined ? [m.name] : [m.name, m.alias];
}

function flagsOf(option: UsageOption): string[] {
  return [...(option.short === null ? [] : [`-${option.short}`]), `--${option.long}`];
}

function zshSpec(option: UsageOption): string {
  const summary = option.summary
    .replaceAll("'", String.raw`'\''`)
    .replaceAll(/([[\]])/g, String.raw`\$1`);
  const value = option.type === 'bool' ? '' : `:${option.long}:`;
  if (option.short === null) return `'--${option.long}[${summary}]${value}'`;
  return `'(-${option.short} --${option.long})'{-${option.short},--${option.long}}'[${summary}]${value}'`;
}

function zsh(m: ToolManifest, options: UsageOption[]): string {
  return [
    `#compdef ${names(m).join(' ')}`,
    '',
    '_arguments -s \\',
    ...options.map((option) => `  ${zshSpec(option)} \\`),
    "  '*:file:_files'",
    '',
  ].join('\n');
}

function bash(m: ToolManifest, options: UsageOption[]): string {
  const fn = `_tbx_complete_${m.name.replaceAll('-', '_')}`;
  const flags = options.flatMap((option) => flagsOf(option)).join(' ');
  return [
    `${fn}() {`,
    '  local cur="${COMP_WORDS[COMP_CWORD]}" flag',
    '  COMPREPLY=()',
    `  for flag in ${flags}; do`,
    '    [[ $flag == "$cur"* ]] && COMPREPLY+=("$flag")',
    '  done',
    '}',
    `complete -F ${fn} ${names(m).join(' ')}`,
    '',
  ].join('\n');
}

function fish(m: ToolManifest, options: UsageOption[]): string {
  const lines = names(m).flatMap((name) =>
    options.map((option) => {
      const short = option.short === null ? '' : ` -s ${option.short}`;
      const value = option.type === 'bool' ? '' : ' -r';
      const summary = option.summary.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`);
      return `complete -c ${name} -l ${option.long}${short}${value} -d '${summary}'`;
    }),
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Renders a completion script for one shell from the manifest's options and the built-in
 * flags. The tool name and its alias both complete. zsh output starts with `#compdef`.
 */
export function renderCompletions(m: ToolManifest, shell: CompletionShell): string {
  const { options } = usageOf(m);
  const renderers = { zsh, bash, fish };
  return renderers[shell](m, options);
}

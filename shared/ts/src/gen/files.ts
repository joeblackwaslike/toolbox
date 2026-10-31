/** A generated file: `path` is relative to the repo root, `content` ends with a newline. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Orders two strings by UTF-16 code unit, so every runtime and ICU version sorts generated
 * output the same way.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

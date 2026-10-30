/** A generated file: `path` is relative to the repo root, `content` ends with a newline. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** Orders two strings the same way on every machine, for deterministic generated output. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}

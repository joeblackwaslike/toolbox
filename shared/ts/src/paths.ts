import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { compareText } from './gen/files.ts';

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Lists the entry names in every directory of a PATH-style string, sorted and without
 * duplicates. Empty entries and directories that cannot be read are skipped. Every name
 * counts, executable or not.
 *
 * @param pathVariable the PATH value; defaults to `process.env.PATH`.
 */
export async function binariesOnPath(
  pathVariable: string = process.env.PATH ?? '',
): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of pathVariable.split(path.delimiter).filter((entry) => entry !== '')) {
    for (const name of await entriesOf(dir)) names.add(name);
  }
  return [...names].sort(compareText);
}

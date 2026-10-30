import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDrift, syncGenerated, undocumentedSymbols } from './index.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(check: boolean): Promise<number> {
  if (check) {
    const drift = await checkDrift(REPO_ROOT);
    for (const entry of drift) process.stderr.write(`drift: ${entry}\n`);
    return drift.length === 0 ? 0 : 1;
  }
  await syncGenerated(REPO_ROOT);
  const missing = await undocumentedSymbols(REPO_ROOT);
  for (const entry of missing) process.stderr.write(`${entry}\n`);
  return missing.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.includes('--check'));

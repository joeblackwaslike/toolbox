import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { z } from 'zod';
import { generateShellParser } from '../../../shared/sh/gen-parser.ts';
import { ExitCode, ToolError, isErrnoException, messageOf } from '../../../shared/ts/src/errors.ts';
import { compareText } from '../../../shared/ts/src/gen/files.ts';
import { loadToolManifests } from '../../../shared/ts/src/gen/index.ts';
import { NAME_PATTERN, type ToolManifest, loadManifest } from '../../../shared/ts/src/manifest.ts';
import { EXECUTABLE_MODE } from '../../../shared/ts/src/paths.ts';
import { CommandError, runBounded } from '../../../shared/ts/src/run.ts';
import { packTar, sha256 } from '../archive.ts';
import type { TbxContext } from '../context.ts';
import { assertToolName, withVariable, writeFileAtomic } from '../state.ts';

const INDEX_FILE = 'index.json';
const READABLE = 0o644;
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');
const MS_PER_SECOND = 1000;
const CHECKOUT_LOADER_START = '\nif ! declare -F _tbx_parse >/dev/null; then\n';
const CHECKOUT_LOADER_END = '\nfi\n';
const SOURCE_COMMAND = /^(?:source|\.)\s/;

/** Longest one build step (an esbuild bundle or a `uv` command) may run before the build fails. */
export const BUILD_STEP_TIMEOUT_MS = 300_000;

/** Directory `tbx build` writes to and `tbx install` reads `index.json` from by default. */
export const DEFAULT_RELEASE_DIR = 'dist/release';

/**
 * One tool in a release index. `artifact` is the `.tar.gz` path relative to the directory that
 * holds `index.json`; `sha256` is its hex checksum.
 */
export interface IndexEntry {
  name: string;
  version: string;
  artifact: string;
  sha256: string;
}

/** What `buildTool` produced: the absolute artifact path, its checksum and the tool version. */
export interface BuildResult {
  artifact: string;
  sha256: string;
  version: string;
}

const indexSchema = z.strictObject({
  tools: z.array(
    z.strictObject({
      name: z.string().regex(NAME_PATTERN),
      version: z.string().min(1),
      artifact: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

/**
 * Reads the entries of a release index.
 *
 * @throws {ToolError} exit 1 when the file is missing (pointing at `tbx build`), exit 78 when it
 * is not a valid index.
 */
export async function readIndex(file: string): Promise<IndexEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new ToolError(`no release index at ${file}; run \`tbx build\` first`);
    }
    throw error;
  }
  try {
    return indexSchema.parse(JSON.parse(text)).tools;
  } catch (error) {
    throw new ToolError(
      `${file} is not a valid release index: ${messageOf(error)}`,
      ExitCode.config,
    );
  }
}

/**
 * Writes `<outDir>/index.json` as `{ "tools": entries }`, sorted by name, atomically, and returns
 * its path.
 */
export async function writeIndex(outDir: string, entries: IndexEntry[]): Promise<string> {
  const file = path.join(outDir, INDEX_FILE);
  const tools = [...entries].sort((a, b) => compareText(a.name, b.name));
  await writeFileAtomic(file, `${JSON.stringify({ tools }, null, 2)}\n`);
  return file;
}

async function withinLimit<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ToolError(`${what} timed out after ${BUILD_STEP_TIMEOUT_MS / MS_PER_SECOND}s`));
    }, BUILD_STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function bundleTs(root: string, name: string): Promise<Buffer> {
  const bundling = esbuild({
    entryPoints: [path.join(root, 'tools', name, 'src/index.ts')],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    banner: { js: '#!/usr/bin/env bun' },
    plugins: [
      {
        name: 'tool-toml-text',
        setup(plugin) {
          plugin.onLoad({ filter: /\.toml$/ }, async (args) => ({
            contents: await readFile(args.path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  const result = await withinLimit(bundling, `esbuild bundle of ${name}`);
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error(`esbuild produced no output for ${name}`);
  return Buffer.from(output.contents);
}

function withoutShebang(text: string): string {
  return text.startsWith('#!') ? text.slice(text.indexOf('\n') + 1) : text;
}

function withoutCheckoutLoader(text: string): string {
  const start = text.indexOf(CHECKOUT_LOADER_START);
  if (start === -1) return text;
  const end = text.indexOf(CHECKOUT_LOADER_END, start + CHECKOUT_LOADER_START.length);
  return end === -1
    ? text
    : `${text.slice(0, start)}\n${text.slice(end + CHECKOUT_LOADER_END.length)}`;
}

async function bundleSh(root: string, m: ToolManifest): Promise<Buffer> {
  const entry = `tools/${m.name}/src/${m.name}`;
  const library = await readFile(path.join(root, 'shared/sh/lib.sh'), 'utf8');
  const source = await readFile(path.join(root, entry), 'utf8');
  const body = withoutCheckoutLoader(withoutShebang(source));
  const sourced = body.split('\n').find((line) => SOURCE_COMMAND.test(line.trimStart()));
  if (sourced !== undefined) {
    throw new ToolError(
      `${entry} sources a file the build cannot inline: ${sourced.trim()}`,
      ExitCode.config,
    );
  }
  const parts = ['#!/usr/bin/env bash', withoutShebang(library), generateShellParser(m), body];
  return Buffer.from(`${parts.map((part) => part.trimEnd()).join('\n\n')}\n`);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env = process.env,
): Promise<string> {
  try {
    const { stdout } = await runBounded(command, args, {
      cwd,
      env,
      timeoutMs: BUILD_STEP_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof CommandError ? error.stderr : (error as Error).message;
    throw new ToolError(`${command} ${args.join(' ')} failed: ${detail.trim()}`);
  }
}

async function pinTimes(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { recursive: true })) {
    await utimes(path.join(dir, entry), FIXED_MTIME, FIXED_MTIME);
  }
  await utimes(dir, FIXED_MTIME, FIXED_MTIME);
}

async function vendorPython(root: string, app: string, work: string): Promise<void> {
  const requirements = path.join(work, 'requirements.txt');
  const pins = await run(
    'uv',
    [
      'export',
      '--frozen',
      '--no-dev',
      '--no-hashes',
      '--no-header',
      '--no-annotate',
      '--no-emit-workspace',
      '--package',
      'tbx-shared',
    ],
    root,
  );
  await writeFile(requirements, pins);
  await run(
    'uv',
    ['pip', 'install', '--quiet', '--no-deps', '--target', app, '-r', requirements],
    root,
  );
  await rm(path.join(app, 'bin'), { recursive: true, force: true });
  await cp(path.join(root, 'shared/py/tbx_shared'), path.join(app, 'tbx_shared'), {
    recursive: true,
    filter: (source) => !source.includes('__pycache__'),
  });
}

async function bundlePy(root: string, m: ToolManifest): Promise<Buffer> {
  const ident = m.name.replaceAll('-', '_');
  const work = await mkdtemp(path.join(tmpdir(), 'tbx-build-py-'));
  try {
    const app = path.join(work, 'app');
    await vendorPython(root, app, work);
    await cp(path.join(root, 'tools', m.name, 'src', `${ident}.py`), path.join(app, `${ident}.py`));
    await cp(path.join(root, 'tools', m.name, 'tool.toml'), path.join(app, 'tool.toml'));
    await writeFile(
      path.join(app, '__main__.py'),
      `import runpy\n\nrunpy.run_module("${ident}", run_name="__main__", alter_sys=True)\n`,
    );
    await pinTimes(app);
    const target = path.join(work, m.name);
    await run(
      'uv',
      [
        'run',
        '--no-project',
        'python',
        '-m',
        'zipapp',
        app,
        '-o',
        target,
        '-p',
        '/usr/bin/env python3',
      ],
      root,
      withVariable(process.env, 'TZ', 'UTC'),
    );
    return await readFile(target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function bundle(root: string, m: ToolManifest): Promise<Buffer> {
  try {
    if (m.language === 'ts') return await bundleTs(root, m.name);
    return await (m.language === 'sh' ? bundleSh(root, m) : bundlePy(root, m));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`build of ${m.name} failed: ${messageOf(error)}`);
  }
}

/**
 * Builds `tools/<name>` into the self-contained artifact `<outDir>/<name>-<version>.tar.gz`
 * holding exactly `bin/<name>` and `tool.toml`. TypeScript is bundled with esbuild (shared code
 * and dependencies included, `tool.toml` inlined as text, `#!/usr/bin/env bun`); shell is one
 * file of `lib.sh`, the generated parser and the tool source with its checkout loader removed;
 * Python is a zipapp with `tbx_shared`, its locked dependencies and `tool.toml` vendored in,
 * started with `#!/usr/bin/env python3`. The archive is deterministic, so a rebuild of the same
 * checkout gives the same checksum.
 *
 * @throws {ToolError} exit 2 for an invalid name, exit 78 for a shell source the build cannot
 * inline, exit 1 when a build step fails.
 * @throws {ManifestError} when `tools/<name>/tool.toml` is missing or invalid.
 */
export async function buildTool(root: string, name: string, outDir: string): Promise<BuildResult> {
  assertToolName(name);
  const toml = path.join(root, 'tools', name, 'tool.toml');
  const m = await loadManifest(toml);
  if (m.name !== name) {
    throw new ToolError(`${toml} names tool "${m.name}", expected "${name}"`, ExitCode.config);
  }
  const archive = packTar([
    { path: `bin/${name}`, content: await bundle(root, m), mode: EXECUTABLE_MODE },
    { path: 'tool.toml', content: await readFile(toml), mode: READABLE },
  ]);
  await mkdir(outDir, { recursive: true, mode: EXECUTABLE_MODE });
  const artifact = path.join(outDir, `${name}-${m.version}.tar.gz`);
  await writeFileAtomic(artifact, archive);
  return { artifact, sha256: sha256(archive), version: m.version };
}

async function existingEntries(outDir: string): Promise<IndexEntry[]> {
  try {
    return await readIndex(path.join(outDir, INDEX_FILE));
  } catch (error) {
    if (error instanceof ToolError && error.code === ExitCode.failure) return [];
    throw error;
  }
}

async function toolNames(root: string): Promise<string[]> {
  const manifests = await loadToolManifests(root);
  return manifests.map((m) => m.name);
}

/**
 * `tbx build <name|all> [--out <dir>]`: builds one tool, or every tool under `tools/`, into
 * `<dir>` (default `dist/release` under the repo root; a relative `--out` is resolved against
 * the working directory) and merges them into its `index.json`.
 */
export async function build(
  ctx: TbxContext,
  target: string,
  options: { out?: string },
): Promise<void> {
  const outDir =
    options.out === undefined
      ? path.join(ctx.root, DEFAULT_RELEASE_DIR)
      : path.resolve(options.out);
  const names = target === 'all' ? await toolNames(ctx.root) : [target];
  const built: IndexEntry[] = [];
  for (const name of names) {
    const result = await buildTool(ctx.root, name, outDir);
    built.push({
      name,
      version: result.version,
      artifact: path.basename(result.artifact),
      sha256: result.sha256,
    });
  }
  const existing = await existingEntries(outDir);
  const kept = existing.filter((entry) => !built.some((tool) => tool.name === entry.name));
  const index = await writeIndex(outDir, [...kept, ...built]);
  ctx.out.result(
    ctx.json
      ? { index, built }
      : [...built.map((tool) => `built ${tool.name} ${tool.version}`), `index ${index}`].join('\n'),
  );
}

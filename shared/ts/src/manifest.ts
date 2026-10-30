import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;
const MAX_SUMMARY_LENGTH = 80;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const ROOT_PATH = '(root)';

/**
 * Error thrown for any invalid or conflicting tool manifest. `fieldPath` is the dotted path
 * of the failing field (for example `unit.calendar.hour`), or `(root)` when no single field
 * is at fault.
 */
export class ManifestError extends Error {
  readonly fieldPath: string;

  constructor(message: string, fieldPath: string = ROOT_PATH) {
    super(message);
    this.name = 'ManifestError';
    this.fieldPath = fieldPath;
  }
}

const argumentSpecSchema = z.strictObject({
  name: z.string().min(1),
  summary: z.string().min(1),
  required: z.boolean(),
});

type OptSpecType = 'bool' | 'string' | 'int';

const optSpecSchema = z
  .strictObject({
    long: z.string().regex(NAME_PATTERN),
    short: z.string().length(1).optional(),
    summary: z.string().min(1),
    type: z.enum(['bool', 'string', 'int']),
    default: z.union([z.boolean(), z.string(), z.number()]).optional(),
  })
  .superRefine((opt, ctx) => {
    if (opt.default === undefined) return;
    const checks: Record<OptSpecType, (value: unknown) => boolean> = {
      bool: (value) => typeof value === 'boolean',
      string: (value) => typeof value === 'string',
      int: (value) => Number.isInteger(value),
    };
    if (!checks[opt.type](opt.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default must be a ${opt.type} to match type "${opt.type}"`,
      });
    }
  });

const unitSpecSchema = z
  .strictObject({
    kind: z.enum(['schedule', 'daemon']),
    calendar: z
      .strictObject({
        hour: z.number().int().min(0).max(MAX_HOUR),
        minute: z.number().int().min(0).max(MAX_MINUTE),
      })
      .optional(),
    interval: z.number().int().positive().optional(),
    runAtLoad: z.boolean(),
  })
  .superRefine((unit, ctx) => {
    if (unit.kind === 'schedule' && unit.calendar === undefined && unit.interval === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a schedule unit needs calendar or interval',
      });
    }
  });

const toolManifestSchema = z
  .strictObject({
    name: z.string().regex(NAME_PATTERN),
    alias: z.string().regex(NAME_PATTERN).optional(),
    summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
    language: z.enum(['ts', 'py', 'sh']),
    version: z.string().regex(SEMVER_PATTERN),
    platforms: z.array(z.enum(['macos', 'linux'])).min(1),
    args: z.array(argumentSpecSchema).default([]),
    options: z.array(optSpecSchema).default([]),
    unit: unitSpecSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.alias === manifest.name) {
      ctx.addIssue({
        code: 'custom',
        path: ['alias'],
        message: 'alias must differ from name',
      });
    }
  });

/** A positional argument declared in `tool.toml`. */
export type ArgSpec = z.infer<typeof argumentSpecSchema>;
/** A flag or option declared in `tool.toml`. */
export type OptSpec = z.infer<typeof optSpecSchema>;
/** The launchd/systemd unit settings declared in `tool.toml`. */
export type UnitSpec = z.infer<typeof unitSpecSchema>;
/** A validated `tool.toml`. */
export type ToolManifest = z.infer<typeof toolManifestSchema>;

function formatIssue(issue: z.core.$ZodIssue): ManifestError {
  const fieldPath = issue.path.length > 0 ? issue.path.join('.') : ROOT_PATH;
  return new ManifestError(`${fieldPath}: ${issue.message}`, fieldPath);
}

/**
 * Parses and validates the text of a `tool.toml`.
 *
 * @throws {ManifestError} on TOML syntax errors or schema violations, naming the failing field.
 */
export function parseManifest(toml: string): ToolManifest {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (error) {
    throw new ManifestError(
      `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = toolManifestSchema.safeParse(raw);
  if (!result.success) {
    const [first] = result.error.issues;
    throw first ? formatIssue(first) : new ManifestError('invalid manifest');
  }
  return result.data;
}

/**
 * Reads and validates a `tool.toml` from disk.
 *
 * @throws {ManifestError} when the file cannot be read or is invalid; the message names `path`.
 */
export async function loadManifest(path: string): Promise<ToolManifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ManifestError(
      `${path}: cannot read file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseManifest(text);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new ManifestError(`${path}: ${error.message}`, error.fieldPath);
    }
    throw error;
  }
}

function identifiersOf(manifest: ToolManifest): [string, string][] {
  const identifiers: [string, string][] = [[manifest.name, `name of tool "${manifest.name}"`]];
  if (manifest.alias !== undefined) {
    identifiers.push([manifest.alias, `alias of tool "${manifest.name}"`]);
  }
  return identifiers;
}

/**
 * Ensures every tool name and alias is unique across tools and does not shadow a binary
 * already on PATH.
 *
 * @param manifests the tools to check together.
 * @param pathBinaries binary names already present on PATH.
 * @throws {ManifestError} naming both owners of the first colliding identifier.
 */
export function assertNoCollisions(manifests: ToolManifest[], pathBinaries: string[]): void {
  const owners = new Map<string, string>(pathBinaries.map((binary) => [binary, 'PATH binary']));
  for (const [identifier, owner] of manifests.flatMap((manifest) => identifiersOf(manifest))) {
    const existing = owners.get(identifier);
    if (existing !== undefined) {
      throw new ManifestError(`"${identifier}" collides: ${owner} and ${existing}`, identifier);
    }
    owners.set(identifier, owner);
  }
}

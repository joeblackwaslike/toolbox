import type { Output } from '../../shared/ts/src/output.ts';
import type { PathBinary } from '../../shared/ts/src/paths.ts';

const CI_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

/** True when `env.CI` is `1` or `true`. */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  return CI_VALUES.has(env.CI ?? '');
}

/** What every `tbx` command receives once its command line has parsed. */
export interface TbxContext {
  /** Repo root holding `tools/`, `shared/` and `docs/`. */
  readonly root: string;
  /** True when `CI` is `1` or `true`; PATH collisions then fail instead of warning. */
  readonly ci: boolean;
  /**
   * Executables on PATH that a tool name or alias could shadow, excluding anything under the
   * repo root or the tbx-managed bin directory.
   */
  readonly pathBinaries: () => Promise<PathBinary[]>;
  /** Home directory installs resolve against: `HOME` from `env`, else the OS home. */
  readonly home: string;
  /** Environment for the install layout (`XDG_*`, `TBX_BIN_DIR`), `CI` and test hooks. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True when `--json` was given. */
  readonly json: boolean;
  /** Output channel, in JSON mode when `json` is true. */
  readonly out: Output;
}

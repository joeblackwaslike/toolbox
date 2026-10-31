import type { Output } from '../../shared/ts/src/output.ts';

/** What every `tbx` command receives once its command line has parsed. */
export interface TbxContext {
  /** Repo root holding `tools/`, `shared/` and `docs/`. */
  readonly root: string;
  /** PATH value searched for binaries that a tool name or alias would shadow. */
  readonly path: string;
  /** True when `--json` was given. */
  readonly json: boolean;
  /** Output channel, in JSON mode when `json` is true. */
  readonly out: Output;
}

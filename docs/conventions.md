# Conventions

Every tool under `tools/<name>/` follows these rules. `tbx new` scaffolds a tool that already does, and `tbx verify <name>` checks most of them.

## tool.toml

Each tool has one hand-written `tools/<name>/tool.toml`. `tbx gen` reads it to write the tool's README, its zsh, bash and fish completions, `docs/catalog.md` and `docs/llms.txt`, and the build reads it to generate the argument parser. `tbx help <name> --json` prints the same data.

A made-up example:

```toml
name = "clip"
alias = "cl"
summary = "Copy a file's contents to the clipboard"
language = "ts"
version = "0.1.0"
platforms = ["macos", "linux"]

[[args]]
name = "file"
summary = "File to copy"
required = true

[[options]]
long = "trim"
short = "t"
summary = "Strip trailing whitespace first"
type = "bool"
```

The manifest is rejected, with the failing field named, when any of these rules break:

- `name` and `alias` are a lowercase letter followed by up to 15 lowercase letters, digits or dashes. The alias must differ from the name.
- `name` matches the directory: `tools/foo/tool.toml` must say `name = "foo"`.
- Neither `name` nor `alias` is a tbx subcommand: `list`, `help`, `gen`, `new`, `shared`, `build`, `install`, `uninstall`, `verify`, `update` or `doctor`. `tbx <word>` runs an installed tool only when the word is not a subcommand.
- `summary` is 1 to 80 characters. Argument and option summaries are 1 to 200 characters. No summary may contain a control character such as a newline or a tab, because summaries are written into shell completion files and markdown tables.
- `language` is `ts`, `py` or `sh`. `version` is semver. `platforms` lists at least one of `macos` and `linux`.
- Argument names and option longs are lowercase letters and digits in segments joined by single dashes, starting with a letter: `out-dir` and `max-2-retries` are fine, `foo--bar` and `foo-` are not. An option `long` does not start with `no-` and is not a built-in flag (`no-input`, `input`, `json`, `help`). A `short` is one letter or digit other than `y` and `h`. `type` is `bool`, `string` or `int`, and `default` must have that type. A `bool` option cannot default to `true`, since there is no `--no-<flag>` to turn it off.
- Argument names and option longs are unique across both lists, also after each parser turns them into identifiers (camelCase in TypeScript, snake_case in Python, `TBX_OPT_FOO_BAR` in shell), so `foo1` and `foo-1` cannot both exist. Shorts are unique. The TypeScript, Python and shell parsers then read the same command line the same way.
- An `int` value, on the command line or as a `default`, is plain ASCII decimal (`-?(0|[1-9][0-9]*)`) from -9007199254740991 to 9007199254740991. `+3`, `007`, `1e3` and non-ASCII digits are usage errors in every language.
- A `[unit]` has `kind = "schedule"` or `"daemon"` and `runAtLoad`. A schedule needs `[unit.calendar]` (`hour` 0 to 23, `minute` 0 to 59) or `interval` in seconds; a daemon cannot set either, since it runs continuously.

Names and aliases must also be unique across tools and must not shadow an executable already on PATH. `tbx gen` warns about a PATH collision, and fails with exit 78 under `--strict` or `CI=1`. `tbx new` refuses a colliding name.

## Flags and output

Every tool gets three flags from its generated parser:

| Flag | Effect |
| --- | --- |
| `-y`, `--no-input` | Never prompt. A tool may prompt only when stdin is a terminal and this flag is absent. |
| `--json` | Print one JSON document to stdout. `--json` also turns prompts off. |
| `-h`, `--help` | Print help. `--help --json` prints the usage that `tool.toml` describes. |

Stdout holds only the result, so `tool > out.md` and `tool --json | jq` work. Progress, warnings and errors go to stderr. When a tool fails it prints nothing on stdout, with or without `--json`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The tool failed. In tbx and in TypeScript tools, an error the code did not expect also exits 1, with `error: <message>` and its cause on stderr instead of a stack trace. |
| 2 | Usage error: an unknown flag, a bad value, a missing or extra argument. |
| 69 | Something the tool needs is missing, such as a command that is not installed or a platform it does not support. |
| 78 | Configuration error, such as an invalid `tool.toml`. |

A tool documents its own codes in `docs/guide.md`. The shared helpers throw or exit with these codes: `ToolError` in TypeScript (`shared/ts/src/errors.ts`) and Python (`tbx_shared.errors`), and `tbx_die` in shell (`shared/sh/lib.sh`).

## Files, config and secrets

Config and state go under the XDG directories: `$XDG_CONFIG_HOME` (default `~/.config`), `$XDG_DATA_HOME` (default `~/.local/share`) and `$XDG_STATE_HOME` (default `~/.local/state`). A relative value in one of these variables is ignored and the default is used, as the XDG Base Directory spec says. tbx itself installs under `$XDG_DATA_HOME/tbx` and keeps its install record in `$XDG_STATE_HOME/tbx`.

Secrets come from the environment or from 1Password. No tool reads a secret from a file in the repo, and none is committed. `tbx verify` runs a tool's unit tests without any environment variable whose name contains `TOKEN`, `KEY`, `SECRET`, `PASSWORD` or `AUTH`.

## Reuse first and shared docs

Before you write a helper inside a tool, search `shared/`:

```sh
pnpm tbx shared search <word>
```

If another tool has the same need now, or plausibly will, the helper goes in `shared/` with a test and a doc comment. When a second tool needs a helper that lives inside one tool, move it to `shared/` in the same change. `pnpm tbx shared new <name> --lang ts|py|sh` scaffolds a module with a failing test and a doc stub.

Every public symbol under `shared/` has a doc comment: TSDoc in TypeScript, a docstring in Python, a shdoc header in shell. `tbx gen` builds `docs/shared/index.md` and one page per module from those comments. `just gen-check` fails when a public shared symbol has no doc comment or when a generated page is out of date.

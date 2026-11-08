# mdlink guide

`mdlink <path> [text]` prints a markdown link to a file or directory, with the target relative to the workspace root. Use it whenever you need to write a link, so the label and target are never typed by hand.

## Examples

```sh
mdlink dist/AGENTS.md                # [dist/AGENTS.md](dist/AGENTS.md)
mdlink src/app.ts:42                 # [src/app.ts:42](src/app.ts#L42)
mdlink src/app.ts:42-51 "the loop"   # [the loop](src/app.ts#L42-L51)
mdlink "docs/with space.md"          # [docs/with space.md](docs/with%20space.md)
```

## The workspace root

By default the root is the main checkout of the current repo, found through `git rev-parse --git-common-dir`. Run from inside a worktree, a path comes out as `.worktrees/<name>/...`, which is the path your editor needs when it has the main checkout open. `--root <dir>` overrides this. A root that is a symlink or has a trailing slash is resolved first.

A path outside the root stays absolute. The root itself becomes `.`.

## Output

The label is the relative path plus any `:LINE` suffix, unless you pass `text`. The text is never escaped, so it can hold markdown such as a code span.

The target is percent-encoded for `%`, space, `#`, `?`, `(` and `)`. Those characters would otherwise end the destination or change what it points at. A `:LINE` or `:LINE-END` suffix becomes a `#L` anchor and is not part of the path, unless a file with that exact name exists.

With `--json` the tool prints the link as one JSON string.

A path that does not exist still gets a link. The tool warns on stderr first, because a dead link is easier to spot than a missing one.

Stdout holds only the link, so `mdlink <path> | pbcopy` works.

## Requirements

`git` on PATH, unless you pass `--root`. `--json` also needs `jq`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The link was printed. |
| 1 | Not inside a git repo and no `--root`, the root does not exist, or the path's directory does not exist. |
| 2 | Usage error: no path, an unknown flag, a line number below 1, or a line range that ends before it starts. |

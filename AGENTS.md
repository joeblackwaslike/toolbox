# toolbox

## Code review

The hosted OpenAI review bot has no credit left, so it won't review PRs. Run the reviews locally before opening a PR and again on the fix batch:

```sh
ai-review review --full
ai-review watch
```

Check each finding against the code before acting on it. The local bot re-raises findings that were already declined.

Remove this section once the OpenAI account has credit again.

## Publishing

`release.yml` is the only path that publishes `tbx-cli` (npm and PyPI) and the tool releases. Never publish from a laptop. release-please opens the release PRs, and a person or agent merges them. The repo is public, so keep tokens out of the tree.

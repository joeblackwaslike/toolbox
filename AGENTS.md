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

`tbx-cli` is published to npm and PyPI from GitHub Actions only. Never publish from a laptop. The repo is going public, so keep tokens out of the tree.

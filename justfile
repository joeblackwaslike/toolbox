default:
  @just --list

install:
  pnpm install
  uv sync

lint: lint-ts lint-py lint-sh

lint-ts:
  pnpm typecheck
  pnpm lint

lint-py:
  uv run ruff check .
  uv run ruff format --check .
  uv run mypy shared/py/tbx_shared

lint-sh:
  #!/usr/bin/env bash
  set -euo pipefail
  files=$(git ls-files -co --exclude-standard -- '*.sh' '*.bash')
  [ -z "$files" ] && exit 0
  shellcheck $files
  shfmt -d $files

format-sh:
  #!/usr/bin/env bash
  set -euo pipefail
  files=$(git ls-files -co --exclude-standard -- '*.sh' '*.bash')
  [ -z "$files" ] && exit 0
  shfmt -w $files

test: test-ts test-py test-sh

test-ts:
  pnpm test

test-py:
  #!/usr/bin/env bash
  set -euo pipefail
  if ! { find shared/py tests tools \( -name 'test_*.py' -o -name '*_test.py' \) -not -path '*/.venv/*' 2>/dev/null || true; } | grep -q .; then
    echo "no python tests, skipping"
    exit 0
  fi
  uv run pytest -p no:faulthandler --no-header -q

test-sh:
  #!/usr/bin/env bash
  set -euo pipefail
  files=$(git ls-files -co --exclude-standard -- '*.bats')
  [ -z "$files" ] && exit 0
  bats $files

gen:
  pnpm --silent tbx gen

gen-check:
  pnpm --silent tbx gen --check

verify-all: lint test gen-check

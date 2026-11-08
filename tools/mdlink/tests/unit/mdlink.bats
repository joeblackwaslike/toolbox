#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup_file() {
  REPO="$BATS_FILE_TMPDIR/repo"
  mkdir -p "$REPO/docs" "$BATS_FILE_TMPDIR/elsewhere"
  git -C "$REPO" init -q
  git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat" -b feat
  touch "$REPO/docs/a.md" "$REPO/docs/with space.md" "$REPO/.worktrees/feat/docs.md" \
    "$BATS_FILE_TMPDIR/elsewhere/x.md"
  REPO=$(cd "$REPO" && pwd -P)
  ELSEWHERE=$(cd "$BATS_FILE_TMPDIR/elsewhere" && pwd -P)
  export REPO ELSEWHERE
}

setup() {
  TOOL="${MDLINK_TOOL:-${BATS_TEST_DIRNAME}/../../src/mdlink}"
}

@test "a file in the main checkout gets a root-relative link" {
  cd "$REPO"
  run bash "$TOOL" docs/a.md
  [ "$status" -eq 0 ]
  [ "$output" = '[docs/a.md](docs/a.md)' ]
}

@test "a file in a worktree keeps the .worktrees prefix" {
  cd "$REPO/.worktrees/feat"
  run bash "$TOOL" docs.md
  [ "$status" -eq 0 ]
  [ "$output" = '[.worktrees/feat/docs.md](.worktrees/feat/docs.md)' ]
}

@test "an absolute path resolves against the root" {
  cd "$REPO/docs"
  run bash "$TOOL" "$REPO/docs/a.md"
  [ "$output" = '[docs/a.md](docs/a.md)' ]
}

@test ":LINE becomes a #L anchor" {
  cd "$REPO"
  run bash "$TOOL" docs/a.md:42
  [ "$output" = '[docs/a.md:42](docs/a.md#L42)' ]
}

@test ":START-END with custom text" {
  cd "$REPO"
  run bash "$TOOL" docs/a.md:42-51 "the loop"
  [ "$output" = '[the loop](docs/a.md#L42-L51)' ]
}

@test "a space is encoded in the target only" {
  cd "$REPO"
  run bash "$TOOL" "docs/with space.md"
  [ "$output" = '[docs/with space.md](docs/with%20space.md)' ]
}

@test "a directory gets a link" {
  cd "$REPO"
  run bash "$TOOL" docs
  [ "$output" = '[docs](docs)' ]
}

@test "a path outside the root stays absolute" {
  cd "$REPO"
  run bash "$TOOL" "$ELSEWHERE/x.md"
  [ "$output" = "[$ELSEWHERE/x.md]($ELSEWHERE/x.md)" ]
}

@test "--root overrides the detected root" {
  cd "$REPO"
  run bash "$TOOL" --root "$REPO/docs" docs/a.md
  [ "$output" = '[a.md](a.md)' ]
}

@test "a missing file warns on stderr and still prints the link" {
  cd "$REPO"
  run --separate-stderr bash "$TOOL" docs/missing.md
  [ "$status" -eq 0 ]
  [ "$output" = '[docs/missing.md](docs/missing.md)' ]
  [[ "$stderr" == "warning: $REPO/docs/missing.md does not exist" ]]
}

@test "--json prints the link as a JSON string" {
  cd "$REPO"
  run --separate-stderr bash "$TOOL" --json docs/a.md
  [ "$status" -eq 0 ]
  [ "$output" = '"[docs/a.md](docs/a.md)"' ]
}

@test "a missing directory fails with exit 1 and nothing on stdout" {
  cd "$REPO"
  run --separate-stderr bash "$TOOL" nope/a.md
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}

@test "no path is a usage error" {
  run --separate-stderr bash "$TOOL"
  [ "$status" -eq 2 ]
}

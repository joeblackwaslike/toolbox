#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/publish-brew.sh"
  export GIT_AUTHOR_NAME=bot GIT_AUTHOR_EMAIL=bot@example.com
  export GIT_COMMITTER_NAME=bot GIT_COMMITTER_EMAIL=bot@example.com
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export HOMEBREW_TAP_TOKEN=test-token
  export TAP_URL="${BATS_TEST_TMPDIR}/tap.git"
  git init --quiet --bare --initial-branch=main "$TAP_URL"
  local seed="${BATS_TEST_TMPDIR}/seed"
  git init --quiet --initial-branch=main "$seed"
  printf 'tap\n' >"${seed}/README.md"
  git -C "$seed" add README.md
  git -C "$seed" commit --quiet -m init
  git -C "$seed" push --quiet "$TAP_URL" main
  FORMULA="${BATS_TEST_TMPDIR}/tbx-cli.rb"
  printf 'class TbxCli < Formula\n  version "0.1.0"\nend\n' >"$FORMULA"
}

tap_log() {
  git -C "$TAP_URL" log --format=%s main
}

tap_file() {
  git -C "$TAP_URL" show main:Formula/tbx-cli.rb
}

reject_pushes() {
  cat >"${TAP_URL}/hooks/pre-receive" <<EOF
#!/usr/bin/env bash
count=\$(cat '${BATS_TEST_TMPDIR}/rejections' 2>/dev/null || echo 0)
if [ "\$count" -lt $1 ]; then
  echo \$((count + 1)) >'${BATS_TEST_TMPDIR}/rejections'
  echo rejected >&2
  exit 1
fi
EOF
  chmod +x "${TAP_URL}/hooks/pre-receive"
}

@test "commits and pushes Formula/tbx-cli.rb" {
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.1.0
  [ "$status" -eq 0 ]
  [ "$(tap_log | head -n 1)" = "tbx-cli 0.1.0" ]
  [ "$(tap_file)" = "$(cat "$FORMULA")" ]
}

@test "skips the commit when the formula already names the version" {
  "$SCRIPT" "$FORMULA" 0.1.0
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.1.0
  [ "$status" -eq 0 ]
  [ "$(tap_log | wc -l | tr -d ' ')" -eq 2 ]
  [[ "$output" == *"already"*"0.1.0"* ]]
}

@test "replaces a formula for an older version" {
  "$SCRIPT" "$FORMULA" 0.1.0
  printf 'class TbxCli < Formula\n  version "0.2.0"\nend\n' >"$FORMULA"
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.2.0
  [ "$status" -eq 0 ]
  [ "$(tap_log | head -n 1)" = "tbx-cli 0.2.0" ]
  [[ "$(tap_file)" == *'version "0.2.0"'* ]]
}

@test "rebases and retries a rejected push" {
  reject_pushes 2
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.1.0
  [ "$status" -eq 0 ]
  [ "$(tap_log | head -n 1)" = "tbx-cli 0.1.0" ]
}

@test "fails after three retries" {
  reject_pushes 99
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.1.0
  [ "$status" -ne 0 ]
  [ "$(cat "${BATS_TEST_TMPDIR}/rejections")" -eq 4 ]
  [[ "$stderr" == *"3 retries"* ]]
}

@test "fails with a message naming HOMEBREW_TAP_TOKEN when the token is empty" {
  HOMEBREW_TAP_TOKEN='' run --separate-stderr "$SCRIPT" "$FORMULA" 0.1.0
  [ "$status" -ne 0 ]
  [[ "$stderr" == *HOMEBREW_TAP_TOKEN* ]]
  [ "$(tap_log | wc -l | tr -d ' ')" -eq 1 ]
}

@test "fails when the formula does not name the version" {
  run --separate-stderr "$SCRIPT" "$FORMULA" 0.3.0
  [ "$status" -ne 0 ]
  [ "$(tap_log | wc -l | tr -d ' ')" -eq 1 ]
}

@test "rejects a call with missing arguments" {
  run "$SCRIPT" "$FORMULA"
  [ "$status" -eq 2 ]
}

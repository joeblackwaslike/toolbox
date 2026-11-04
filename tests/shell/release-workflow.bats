#!/usr/bin/env bats
# Structural checks on release.yml. GitHub is the real consumer and cannot run here, so these
# assert the invariants that keep secrets out of shell text and keep the job order safe.

bats_require_minimum_version 1.5.0

setup_file() {
  export WORKFLOW_JSON="${BATS_FILE_TMPDIR}/release.json"
  bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))' \
    <"${BATS_TEST_DIRNAME}/../../.github/workflows/release.yml" >"$WORKFLOW_JSON"
}

q() {
  jq -e "$@" "$WORKFLOW_JSON"
}

needs_of() {
  jq -c --arg j "$1" '.jobs[$j].needs | if type == "string" then [.] else . end' "$WORKFLOW_JSON"
}

if_of() {
  jq -r --arg j "$1" '.jobs[$j].if // "" | gsub("\\$\\{\\{|\\}\\}"; "") | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ")' "$WORKFLOW_JSON"
}

readonly CLI_JOBS=(cli-build sign-macos smoke cli-upload publish-npm publish-pypi publish-brew)

@test "the workflow grants nothing at the top level" {
  q '.permissions == {}'
}

@test "every job sets its own permissions" {
  run jq -r '.jobs | to_entries[] | select(.value.permissions | type != "object") | .key' "$WORKFLOW_JSON"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "the tbx-cli jobs have exactly the permissions the spec lists" {
  q '.jobs["cli-build"].permissions == {contents: "read"}'
  q '.jobs["sign-macos"].permissions == {contents: "read"}'
  q '.jobs.smoke.permissions == {}'
  q '.jobs["cli-upload"].permissions == {contents: "write"}'
  q '.jobs["publish-npm"].permissions == {contents: "read", "id-token": "write"}'
  q '.jobs["publish-pypi"].permissions == {contents: "read", "id-token": "write"}'
  q '.jobs["publish-brew"].permissions == {contents: "read"}'
}

@test "no run block interpolates an expression; values go through env" {
  run jq -r '.jobs | to_entries[] | .key as $j | .value.steps[]? | select((.run // "") | contains("${{")) | "\($j): \(.name)"' "$WORKFLOW_JSON"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "every action is pinned to a full commit SHA" {
  run jq -r '[.. | objects | .uses? | strings] | .[] | select(test("@[0-9a-f]{40}$") | not)' "$WORKFLOW_JSON"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  q '[.. | objects | .uses? | strings] | length > 0'
}

@test "every tbx-cli job that checks out code checks out the release commit without credentials" {
  run jq -r '.jobs | to_entries[] | select(.key | test("^(cli-|sign-macos|smoke|publish-)")) | .key as $j
    | .value.steps[] | select((.uses // "") | startswith("actions/checkout@"))
    | select((.with.ref // "" | contains("needs.resolve.outputs.cli).sha") | not) or .with["persist-credentials"] != false)
    | $j' "$WORKFLOW_JSON"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "the tbx-cli jobs run in order: build, sign, smoke, upload, npm and PyPI, Homebrew" {
  [[ "$(needs_of cli-build)" == *'"resolve"'* ]]
  [[ "$(needs_of sign-macos)" == *'"cli-build"'* ]]
  [[ "$(needs_of smoke)" == *'"sign-macos"'* ]]
  [[ "$(needs_of cli-upload)" == *'"smoke"'* ]]
  [[ "$(needs_of publish-npm)" == *'"cli-upload"'* ]]
  [[ "$(needs_of publish-pypi)" == *'"cli-upload"'* ]]
  [[ "$(needs_of publish-brew)" == *'"publish-npm"'* ]]
  [[ "$(needs_of publish-brew)" == *'"publish-pypi"'* ]]
}

@test "the smoke matrix covers the four platforms on native runners and reports every leg" {
  q '.jobs.smoke.strategy["fail-fast"] == false'
  q '.jobs.smoke.strategy.matrix.include | map("\(.runner)=\(.platform)") | sort ==
    ["macos-15-intel=darwin-x64", "macos-15=darwin-arm64", "ubuntu-24.04-arm=linux-arm64", "ubuntu-24.04=linux-x64"]'
}

@test "cli-upload uploads checksums.txt last and clears a partial release first" {
  run jq -r '.jobs["cli-upload"].steps[] | .run // empty' "$WORKFLOW_JSON"
  [ "$status" -eq 0 ]
  local script=${output//$'\\\n'/ }
  local calls
  calls=$(grep -c 'scripts/upload-release-asset.sh' <<<"$script")
  [ "$calls" -eq 1 ]
  local call last
  call=$(grep 'scripts/upload-release-asset.sh' <<<"$script")
  last=${call##* }
  [[ "$last" == *checksums.txt ]]
  [[ "$call" != *checksums.txt*' '* ]]
  local clear upload
  clear=$(grep -n 'cli-release-state.sh --clear' <<<"$script" | cut -d : -f 1)
  upload=$(grep -n 'scripts/upload-release-asset.sh' <<<"$script" | cut -d : -f 1)
  [ -n "$clear" ] && [ "$clear" -lt "$upload" ]
}

@test "sign-macos gets the five signing secrets through env" {
  q '.jobs["sign-macos"].steps[] | select((.run // "") | contains("sign-macos.sh")) | .env | keys | sort ==
    ["MACOS_CERT_P12", "MACOS_CERT_PASSWORD", "NOTARY_ISSUER_ID", "NOTARY_KEY_ID", "NOTARY_KEY_P8"]'
}

@test "publish-pypi uses trusted publishing in the pypi environment and skips existing files" {
  q '.jobs["publish-pypi"].environment == "pypi"'
  q '.jobs["publish-pypi"].steps[] | select((.uses // "") | startswith("pypa/gh-action-pypi-publish@")) | .with["skip-existing"] == true'
}

@test "every tbx-cli job opts out of the skipped-ancestor rule with !cancelled()" {
  local job
  for job in "${CLI_JOBS[@]}"; do
    [[ "$(if_of "$job")" == '!cancelled() && '* ]] || {
      echo "$job: $(if_of "$job")"
      return 1
    }
  done
}

@test "smoke runs only after cli-build and sign-macos succeed" {
  local gate
  gate=$(if_of smoke)
  [[ "$gate" == *"needs.cli-build.result == 'success'"* ]]
  [[ "$gate" == *"needs.sign-macos.result == 'success'"* ]]
  [[ "$gate" != *'||'* ]]
}

@test "cli-upload uploads only smoked bytes, or nothing for a complete release" {
  local gate
  gate=$(if_of cli-upload)
  [[ "$gate" == *"needs.cli-build.result == 'success'"* ]]
  [[ "$gate" == *"&& (needs.smoke.result == 'success' || needs.cli-build.outputs.state == 'complete')" ]]
}

@test "publish-brew runs only after npm and PyPI both succeed" {
  local gate
  gate=$(if_of publish-brew)
  [[ "$gate" == *"needs.publish-npm.result == 'success'"* ]]
  [[ "$gate" == *"needs.publish-pypi.result == 'success'"* ]]
  [[ "$gate" != *'||'* ]]
}

@test "the npm publish records provenance" {
  q '[.jobs["publish-npm"].steps[] | .run // "" | select(contains("npm publish"))] | length == 1'
  q '.jobs["publish-npm"].steps[] | .run // "" | select(contains("npm publish")) | test("npm publish [^\n]*--provenance")'
}

@test "the write-scoped token in cli-upload reaches only the step that talks to the release" {
  q '.jobs["cli-upload"].env // {} | has("GH_TOKEN") | not'
  run jq -r '.jobs["cli-upload"].steps[] | select(.env.GH_TOKEN) | .name' "$WORKFLOW_JSON"
  [ "$output" = "Upload the binaries and packages, then checksums.txt last" ]
}

@test "index runs after tool-release finished, even with a failed leg, but never when it was skipped or cancelled" {
  [ "$(if_of index)" = "!cancelled() && (needs.tool-release.result == 'success' || needs.tool-release.result == 'failure')" ]
  [[ "$(needs_of index)" == *'"tool-release"'* ]]
}

@test "index adds tools through index-released-tools.sh, which skips tags without a tarball" {
  q '[.jobs.index.steps[] | .run // "" | select(contains("scripts/index-released-tools.sh \"$TOOLS\""))] | length == 1'
  q '[.jobs.index.steps[] | .run // "" | select(contains("publish-index.sh"))] | length == 0'
}

@test "only tool releases drop the repo-wide latest label" {
  run jq -r '.jobs | to_entries[] | select([.value.steps[]? | .run // "" | contains("release-not-latest.sh")] | any) | .key' "$WORKFLOW_JSON"
  [ "$output" = tool-release ]
}

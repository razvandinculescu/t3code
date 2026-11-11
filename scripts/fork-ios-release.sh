#!/usr/bin/env bash
set -euo pipefail
if (( $# < 3 || $# > 4 )); then
  printf 'Usage: t3-ios-release SOURCE_SHA BUILD_NUMBER OUTPUT_DIRECTORY [USB_UDID]\n' >&2
  exit 2
fi
source_sha=$1
build_number=$2
output_dir=$3
usb_udid=${4:-}
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$build_number" =~ ^[0-9]{1,18}$ ]] || exit 2
for required in gh jq git t3-apple-release; do command -v "$required" >/dev/null; done
t3-apple-release doctor
repo=razvandinculescu/t3code
repo_root=$(git -C "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" rev-parse --show-toplevel)
workflow=fork-windows-build.yml
branch=build/ios-native
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Keep the existing dispatch lane while taking its recipe from the exact source being released.
git -C "$repo_root" show "$source_sha:.github/workflows/fork-ios-build.yml" > "$work/workflow.yml"
git -C "$repo_root" fetch --quiet origin "refs/heads/$branch:refs/remotes/origin/$branch"
previous_head=$(git -C "$repo_root" rev-parse "refs/remotes/origin/$branch")
blob=$(git -C "$repo_root" hash-object -w "$work/workflow.yml")
GIT_INDEX_FILE="$work/index" git -C "$repo_root" read-tree "$source_sha"
GIT_INDEX_FILE="$work/index" git -C "$repo_root" update-index --cacheinfo "100644,$blob,.github/workflows/$workflow"
tree=$(GIT_INDEX_FILE="$work/index" git -C "$repo_root" write-tree)
commit=$(git -C "$repo_root" commit-tree "$tree" -p "$source_sha" -p "$previous_head" -m "build: iOS release pipeline for ${source_sha:0:10}")
git -C "$repo_root" push origin "$commit:refs/heads/$branch"

run_name="iOS $source_sha ($build_number)"
previous_id=$(gh run list -R "$repo" --workflow "$workflow" --branch "$branch" --limit 30 --json databaseId | jq '[.[].databaseId] | max // 0')
gh workflow run "$workflow" -R "$repo" --ref "$branch" -f "source-ref=$source_sha" -f "build-number=$build_number"
run_id=
for attempt in {1..30}; do
  matches=$(gh run list -R "$repo" --workflow "$workflow" --branch "$branch" --limit 30 --json databaseId,displayTitle | jq --arg title "$run_name" --argjson previous "$previous_id" '[.[] | select(.displayTitle == $title and .databaseId > $previous)]')
  count=$(jq length <<<"$matches")
  if (( count > 1 )); then printf 'Multiple matching builds; no second dispatch was made.\n' >&2; exit 1; fi
  if (( count == 1 )); then run_id=$(jq -r '.[0].databaseId' <<<"$matches"); break; fi
  sleep 2
done
[[ -n "$run_id" ]] || { printf 'Dispatched run is not visible yet; no duplicate was launched.\n' >&2; exit 1; }
printf 'Building source %s in GitHub run %s\n' "$source_sha" "$run_id"
while true; do
  artifact=$(gh api "repos/$repo/actions/runs/$run_id/artifacts" --jq '.artifacts[] | select(.name == "t3code-ios-unsigned" and .expired == false) | .id')
  [[ -z "$artifact" ]] || break
  status=$(gh run view "$run_id" -R "$repo" --json status,conclusion,jobs)
  if [[ $(jq -r .status <<<"$status") == completed ]]; then
    jq '{status,conclusion}' <<<"$status" >&2
    printf 'Run completed without the release artifact.\n' >&2
    exit 1
  fi
  jq -r '.jobs[].steps[] | select(.status == "in_progress") | "Waiting for artifact: " + .name' <<<"$status"
  sleep 20
done
gh run download "$run_id" -R "$repo" -n t3code-ios-unsigned -D "$work/download"
jq -e --arg sha "$source_sha" --arg build "$build_number" '.sourceCommit == $sha and .buildNumber == $build and .codeSigningAllowed == false and (.outputs | has("main.jsbundle"))' "$work/download/build-info.json" >/dev/null
mkdir -p "$output_dir"
unsigned="$work/unsigned.ipa"
signed="$output_dir/T3-Code-Fork-iOS-${source_sha:0:9}-$build_number.ipa"
t3-apple-release prepare "$work/download/T3-Code-Fork-iOS-unsigned.zip" "$unsigned"
t3-apple-release sign "$unsigned" "$signed"
jq --arg run "$run_id" --arg ready "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {ciRun: $run, signedAt: $ready}' "$work/download/build-info.json" > "$signed.build.json"
if [[ -n "$usb_udid" ]]; then t3-apple-release install "$signed" --udid "$usb_udid"; fi
printf 'Signed IPA ready: %s\n' "$signed"
gh run watch "$run_id" -R "$repo" --exit-status --interval 30
gh run view "$run_id" -R "$repo" --json databaseId,url,status,conclusion,jobs > "$signed.ci.json"

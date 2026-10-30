#!/usr/bin/env bash
# CI と手元で同じ一覧を配り、list の各レコードをいずれか一つの runner に所属させる。
set -euo pipefail

if [ "$#" -lt 6 ]; then
  echo 'Usage: bash scripts/run-ci-tests.sh server|web it|heavy SHARD SHARDS files|tests list|run [vitest run options...]' >&2
  exit 2
fi
package=$1 project=$2 shard=$3 shards=$4 grouping=$5 action=$6
shift 6
case "$package/$project" in server/it|server/heavy|web/it|web/heavy) ;; *) exit 2 ;; esac
case "$grouping" in files|tests) ;; *) exit 2 ;; esac
case "$action" in list|run) ;; *) exit 2 ;; esac
if ! [[ "$shard" =~ ^[0-9]+$ && "$shards" =~ ^[1-9][0-9]*$ ]] || (( shard >= shards )); then
  echo 'Invalid runner index/count' >&2; exit 2
fi
if [ "$package/$project" = server/heavy ] && (( shards < 2 )); then
  echo 'server heavy needs a dedicated bootstrap runner and at least one other runner' >&2; exit 2
fi

mine=$(pnpm --dir "$package" exec vitest list --project "$project" --no-staticParse --includeTaskLocation --json | jq \
  --arg root "$PWD/$package/" --arg package "$package" --arg project "$project" \
  --arg grouping "$grouping" --argjson i "$shard" --argjson n "$shards" '
  map(.file |= ltrimstr($root)) |
  if $package == "server" and $project == "heavy" then
    if $i == 0 then map(select(.file == "test/measureBootstrap.heavy.test.ts"))
    else map(select(.file != "test/measureBootstrap.heavy.test.ts")) end
  else . end |
  group_by(if $grouping == "files" then .file
    else "\(.file):\(.location.line // error("missing test location"))" end) |
  to_entries | map(select(
    if $package == "server" and $project == "heavy" then
      $i == 0 or (.key % ($n - 1) == $i - 1)
    else .key % $n == $i end)) | map(.value[])')

if [ "$action" = list ]; then
  printf '%s\n' "$mine"
  exit 0
fi
count=$(printf '%s' "$mine" | jq length)
echo "$package $project runner $shard/$shards: $count tests" >&2
if [ "$count" -eq 0 ]; then exit 0; fi
targets=$(printf '%s' "$mine" | jq -r --arg grouping "$grouping" '
  map(if $grouping == "files" then .file
    else "\(.file):\(.location.line // error("missing test location"))" end) | unique[]')
mapfile -t target_array <<< "$targets"
pnpm --dir "$package" exec vitest run --project "$project" "${target_array[@]}" "$@"

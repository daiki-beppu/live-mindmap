#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  printf 'Usage: %s <repository> <title> <run-url> <sha> <failed-jobs>\n' "$0" >&2
  exit 1
fi

repository="$1"
title="$2"
run_url="$3"
sha="$4"
failed_jobs="$5"

for value in "$repository" "$title" "$run_url" "$sha" "$failed_jobs"; do
  if [ -z "$value" ]; then
    printf 'All notification inputs must be nonempty.\n' >&2
    exit 1
  fi
done

issue_number=$(gh api graphql --paginate -f owner="${repository%%/*}" -f name="${repository#*/}" -f query='
  query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $endCursor, states: [OPEN], labels: ["bug"], orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { number title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }' --jq '.data.repository.issues.nodes' |
  jq -sr --arg title "$title" '[.[][] | select(.title == $title)] | first | .number // empty')

body=$(printf 'Run: %s\nSHA: %s\n\n落ちたジョブ:\n' "$run_url" "$sha"
  printf '%s\n' "$failed_jobs" | while IFS= read -r job; do
    printf -- '- %s\n' "$job"
  done)

if [ -n "$issue_number" ]; then
  printf '%s\n' "$body" | gh issue comment "$issue_number" --repo "$repository" --body-file -
else
  printf '%s\n' "$body" | gh issue create --repo "$repository" --title "$title" --label bug --label needs-triage --body-file -
fi

#!/usr/bin/env bash
set -euo pipefail
run=$1; shift
cd "$run"
exec playwright-cli -s="verify-$(cat web-port)" "$@"

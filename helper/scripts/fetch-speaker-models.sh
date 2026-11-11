#!/usr/bin/env bash
set -euo pipefail

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$HELPER_DIR/.build/release/live-mindmap-helper"

if [ ! -x "$HELPER" ]; then
  swift build -c release --package-path "$HELPER_DIR"
fi

"$HELPER" install-speaker-models

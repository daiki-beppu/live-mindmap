#!/usr/bin/env bash
# 話者分離（FluidAudio の Sortformer）のモデルを、セットアップの段で前もって取得する（Issue #1020）。
# 保存先は FluidAudio の既定（~/Library/Application Support/FluidAudio/Models）。既に入っていれば何もしない（冪等）。
# 会議の開始時やセッション中にはモデルを取りに行かない。取得の処理はヘルパーの `install-speaker-models` に任せる。
# 後で使う WeSpeaker（FluidAudio 同梱）も、取得の対象を足せば同じ段で取れる。
set -euo pipefail

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HELPER_DIR"

swift run --quiet live-mindmap-helper install-speaker-models

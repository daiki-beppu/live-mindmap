#!/usr/bin/env bash
# 話者分離（FluidAudio の Sortformer）と、枠への混入の検出（Issue #1024）に使う WeSpeaker のモデルを、セットアップの段で前もって取得する（Issue #1020）。
# 保存先は FluidAudio の既定（~/Library/Application Support/FluidAudio/Models）。既に入っていれば何もしない（冪等）。
# 会議の開始時やセッション中にはモデルを取りに行かない。取得の処理はヘルパーの `install-speaker-models` に任せる。
# モデルごとに取得の印を置くので、片方だけ入っている環境でも足りない方だけを取る。
set -euo pipefail

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HELPER_DIR"

swift run --quiet live-mindmap-helper install-speaker-models

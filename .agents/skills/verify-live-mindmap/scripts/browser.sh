#!/usr/bin/env bash
# この run の web を playwright-cli で操作する。セッション名は verify-<web のポート>（ほかの run・利用者のブラウザと混ざらない）。
# run のフォルダで実行するので、playwright-cli が書く snapshot・console のログ（.playwright-cli/）と、相対パスで渡した screenshot は <run> の下に残る。
# 使い方: bash .agents/skills/verify-live-mindmap/scripts/browser.sh <run のフォルダ> <playwright-cli のコマンド> [引数...]
#   例: browser.sh "$RUN" open "http://127.0.0.1:$(cat "$RUN/web-port")/"
#       browser.sh "$RUN" screenshot --filename shots/01-start.png
set -euo pipefail
run=$1; shift
cd "$run"
exec playwright-cli -s="verify-$(cat web-port)" "$@"

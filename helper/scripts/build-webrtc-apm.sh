#!/usr/bin/env bash
# freedesktop の webrtc-audio-processing（WebRTC AEC3）を静的ライブラリとしてビルドし、helper/.deps/webrtc-apm/ に置く。
# 既にビルド済み（lib/libwebrtc-audio-processing-2.a がある）なら何もしない。
# 必要なもの: git, uv（meson と ninja は uvx で一時的に使う）。
set -euo pipefail

REPO_URL="https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git"
# v2.1 の後で、#110 でビルドと効き目を確かめた版
COMMIT="d0569cfa50c1858ee279d77b3fc8870be6902441"

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$HELPER_DIR/.deps/webrtc-apm"
SRC="$DEPS/src"
BUILD="$DEPS/build"
LIB="$DEPS/lib"

if [ -f "$LIB/libwebrtc-audio-processing-2.a" ]; then
  echo "webrtc-apm: already built ($LIB)"
  exit 0
fi

mkdir -p "$DEPS"
if [ ! -d "$SRC/.git" ]; then
  git init --quiet "$SRC"
fi
if [ "$(git -C "$SRC" rev-parse --verify --quiet HEAD || true)" != "$COMMIT" ]; then
  git -C "$SRC" fetch --depth 1 "$REPO_URL" "$COMMIT"
  git -C "$SRC" checkout --quiet --force FETCH_HEAD
fi

# helper の最低対応 macOS（Package.swift の platforms）に合わせる。新しい OS 向けにビルドされるとリンク時に警告が出る
export MACOSX_DEPLOYMENT_TARGET=26.0

rm -rf "$BUILD"
uvx --from meson --with ninja meson setup "$BUILD" "$SRC" \
  --default-library=static --buildtype=release -Dabseil-cpp:default_library=static
uvx --from meson --with ninja meson compile -C "$BUILD"

# 静的ライブラリを lib/ に平らに集める
rm -rf "$LIB"
mkdir -p "$LIB"
find "$BUILD" -name '*.a' -exec cp {} "$LIB/" \;
test -f "$LIB/libwebrtc-audio-processing-2.a"

# abseil の subproject（ヘッダーの場所）への固定名のリンク
ABSEIL="$(find "$SRC/subprojects" -maxdepth 1 -type d -name 'abseil-cpp*' | head -n 1)"
if [ -z "$ABSEIL" ]; then
  echo "webrtc-apm: abseil-cpp subproject not found under $SRC/subprojects" >&2
  exit 1
fi
ln -sfn "$ABSEIL" "$DEPS/abseil"

echo "webrtc-apm: built $(ls "$LIB" | wc -l | tr -d ' ') libraries in $LIB"

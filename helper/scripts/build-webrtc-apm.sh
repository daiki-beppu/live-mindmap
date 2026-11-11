#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git"
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

export MACOSX_DEPLOYMENT_TARGET=26.0

rm -rf "$BUILD"
uvx --from meson --with ninja meson setup "$BUILD" "$SRC" \
  --default-library=static --buildtype=release -Dabseil-cpp:default_library=static
uvx --from meson --with ninja meson compile -C "$BUILD"

rm -rf "$LIB"
mkdir -p "$LIB"
find "$BUILD" -name '*.a' -exec cp {} "$LIB/" \;
test -f "$LIB/libwebrtc-audio-processing-2.a"

ABSEIL="$(find "$SRC/subprojects" -maxdepth 1 -type d -name 'abseil-cpp*' | head -n 1)"
if [ -z "$ABSEIL" ]; then
  echo "webrtc-apm: abseil-cpp subproject not found under $SRC/subprojects" >&2
  exit 1
fi
ln -sfn "$ABSEIL" "$DEPS/abseil"

echo "webrtc-apm: built $(ls "$LIB" | wc -l | tr -d ' ') libraries in $LIB"

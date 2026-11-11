#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git"
COMMIT="d0569cfa50c1858ee279d77b3fc8870be6902441"

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$HELPER_DIR/.deps/webrtc-apm"
SRC="$DEPS/src"
BUILD="$DEPS/build"
LIB="$DEPS/lib"
DEPLOYMENT_TARGET_STAMP="$DEPS/.macos-deployment-target"

MACOSX_DEPLOYMENT_TARGET="$(swift package --package-path "$HELPER_DIR" dump-package | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const platform = JSON.parse(input).platforms.find(platform => platform.platformName === "macos");
  if (!platform || typeof platform.version !== "string" || platform.version.trim() === "") {
    throw new Error("webrtc-apm: Package.swift must declare a macOS deployment target");
  }
  process.stdout.write(platform.version);
});
')"
export MACOSX_DEPLOYMENT_TARGET

if [ -f "$LIB/libwebrtc-audio-processing-2.a" ] &&
   [ -f "$DEPLOYMENT_TARGET_STAMP" ] &&
   [ "$(cat "$DEPLOYMENT_TARGET_STAMP")" = "$MACOSX_DEPLOYMENT_TARGET" ]; then
  echo "webrtc-apm: already built ($LIB)"
  exit 0
fi

mkdir -p "$DEPS"
rm -f "$DEPLOYMENT_TARGET_STAMP"
if [ ! -d "$SRC/.git" ]; then
  git init --quiet "$SRC"
fi
if [ "$(git -C "$SRC" rev-parse --verify --quiet HEAD || true)" != "$COMMIT" ]; then
  git -C "$SRC" fetch --depth 1 "$REPO_URL" "$COMMIT"
  git -C "$SRC" checkout --quiet --force FETCH_HEAD
fi

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
printf '%s\n' "$MACOSX_DEPLOYMENT_TARGET" > "$DEPLOYMENT_TARGET_STAMP"

echo "webrtc-apm: built $(ls "$LIB" | wc -l | tr -d ' ') libraries in $LIB"

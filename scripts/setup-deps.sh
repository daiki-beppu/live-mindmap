#!/usr/bin/env bash
set -euo pipefail

required_node=$(tr -d '[:space:]' < .nvmrc)
case "$required_node" in
  ''|*[!0-9]*) printf 'Invalid Node major in .nvmrc: %s\n' "$required_node" >&2; exit 1 ;;
esac

node_temp=''
cleanup() {
  if [ -n "$node_temp" ]; then rm -rf "$node_temp"; fi
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

setup_node() {
  local current='not installed' node_home arch archive installed expected
  if command -v node >/dev/null 2>&1; then current=$(node -v); fi
  if [ "${current%%.*}" = "v$required_node" ]; then return; fi
  case "$(uname -s)" in
    Darwin)
      printf 'Node.js %s required by .nvmrc; found %s. Install Node.js %s before continuing.\n' "$required_node" "$current" "$required_node" >&2
      exit 1
      ;;
    Linux) ;;
    *) printf 'Unsupported operating system for Node installation\n' >&2; exit 1 ;;
  esac
  node_home="$HOME/.local/node-$required_node"
  installed=''
  if [ -x "$node_home/bin/node" ]; then
    if ! installed=$("$node_home/bin/node" -v); then
      printf 'Existing Node installation is incomplete; reinstalling\n' >&2
      installed=''
    fi
  fi
  if [ "${installed%%.*}" != "v$required_node" ]; then
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) printf 'Unsupported Linux architecture for Node installation\n' >&2; exit 1 ;;
    esac
    mkdir -p "$HOME/.local"
    node_temp=$(mktemp -d "$HOME/.local/.node-$required_node.XXXXXX")
    curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v$required_node.x/SHASUMS256.txt" -o "$node_temp/SHASUMS256.txt"
    archive=$(awk -v suffix="-linux-$arch.tar.gz" 'substr($2, length($2) - length(suffix) + 1) == suffix { print $2 }' "$node_temp/SHASUMS256.txt")
    if [ -z "$archive" ] || [[ "$archive" == *$'\n'* ]]; then
      printf 'Cannot identify Node.js %s archive for %s\n' "$required_node" "$arch" >&2
      exit 1
    fi
    curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v$required_node.x/$archive" -o "$node_temp/$archive"
    expected=$(awk -v archive="$archive" '$2 == archive { print $1 }' "$node_temp/SHASUMS256.txt")
    if [ "$(sha256_file "$node_temp/$archive")" != "$expected" ]; then
      printf 'Node.js archive checksum mismatch\n' >&2
      exit 1
    fi
    mkdir "$node_temp/distribution"
    tar -xzf "$node_temp/$archive" --strip-components=1 -C "$node_temp/distribution"
    installed=$("$node_temp/distribution/bin/node" -v)
    if [ "${installed%%.*}" != "v$required_node" ]; then
      printf 'Downloaded Node.js version mismatch: %s\n' "$installed" >&2
      exit 1
    fi
    rm -rf "$node_home"
    mv "$node_temp/distribution" "$node_home"
  fi
  export PATH="$node_home/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    printf 'export PATH=%q:"$PATH"\n' "$node_home/bin" >> "$CLAUDE_ENV_FILE"
  fi
}

setup_pnpm() {
  local manager
  manager=$(node -p 'require("./package.json").packageManager')
  case "$manager" in
    pnpm@*) ;;
    *) printf 'Expected pnpm in packageManager; found %s\n' "$manager" >&2; exit 1 ;;
  esac
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  else
    npm i -g "$manager"
  fi
}

setup_install() {
  local fingerprint marker=node_modules/.setup-deps-lock
  fingerprint=$(sha256_file pnpm-lock.yaml)
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$fingerprint" ]; then
    printf 'Dependencies match pnpm-lock.yaml; skipping install\n'
    return
  fi
  pnpm install --frozen-lockfile
  mkdir -p node_modules
  printf '%s\n' "$fingerprint" > "$marker"
}

run_stage() {
  local name="$1" started=$SECONDS
  shift
  "$@"
  printf 'setup-deps: %s %s\n' "$name" "$((SECONDS - started))"
}

run_stage node setup_node
run_stage pnpm setup_pnpm
run_stage install setup_install

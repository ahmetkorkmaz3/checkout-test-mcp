#!/usr/bin/env bash
# Builds checkout-test-mcp-<version>.mcpb in the repo root.
# It copies an allow list of files to a temp folder, so no test, doc, or .env file can get in.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(node -p "require('./package.json').version")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

npm run build

mkdir -p "$stage/examples/demo-store"
cp -R dist scenarios test-data schemas "$stage/"
cp examples/demo-store/server.mjs "$stage/examples/demo-store/"
cp LICENSE manifest.json package.json package-lock.json .mcpbignore "$stage/"

# Runtime dependencies only. Skip install scripts: the browser is not part of the bundle.
(cd "$stage" && npm ci --omit=dev --ignore-scripts)

npx mcpb validate "$stage/manifest.json"
out="$root/checkout-test-mcp-${version}.mcpb"
rm -f "$out"
npx mcpb pack "$stage" "$out"
echo "Packed $out" >&2

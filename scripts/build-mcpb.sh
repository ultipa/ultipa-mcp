#!/usr/bin/env bash
# Build a Claude Desktop one-click extension (.mcpb) from the compiled server.
#
# Produces ./gqldb-mcp.mcpb at the repo root — a self-contained bundle (compiled
# JS + production node_modules) that installs into Claude Desktop with one click and
# prompts the user for Ultipa credentials via manifest.json's user_config.
#
# Usage: npm run build:mcpb   (or: bash scripts/build-mcpb.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/mcpb-build"
# Output path. CI overrides this with a tag-matched, versioned name
# (e.g. gqldb-mcp-1.1.0.mcpb) via MCPB_OUT; local builds get the plain name.
OUT="${MCPB_OUT:-$ROOT/gqldb-mcp.mcpb}"
MCPB="@anthropic-ai/mcpb@latest"

cd "$ROOT"

echo "→ Compiling TypeScript (npm run build)…"
npm run build

echo "→ Staging bundle in mcpb-build/ …"
rm -rf "$STAGE"
mkdir -p "$STAGE/server"
# Compiled server. index.js reads ../package.json for its version at runtime, so the
# bundle root (one level up from server/) must contain package.json — copied below.
cp -R dist/. "$STAGE/server/"
cp manifest.json "$STAGE/manifest.json"
cp package.json package-lock.json "$STAGE/"
[ -f README.md ] && cp README.md "$STAGE/"
[ -f LICENSE ] && cp LICENSE "$STAGE/"
# Extension icon shown in Claude Desktop — must sit at the bundle root next to manifest.json.
[ -f icon.png ] && cp icon.png "$STAGE/"

echo "→ Syncing manifest version from package.json…"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const p = "mcpb-build/manifest.json";
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.version = pkg.version;
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  console.log("   manifest version = " + m.version);
'

echo "→ Installing production dependencies into the bundle…"
# Production deps only. Node resolves them from the bundle root when running server/index.js.
( cd "$STAGE" && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) )
# package-lock.json is only needed for the install above; drop it from the shipped bundle.
rm -f "$STAGE/package-lock.json"

echo "→ Validating staged manifest…"
npx --yes "$MCPB" validate "$STAGE/manifest.json"

echo "→ Packing gqldb-mcp.mcpb …"
rm -f "$OUT"
npx --yes "$MCPB" pack "$STAGE" "$OUT"

echo "→ Bundle info:"
npx --yes "$MCPB" info "$OUT"

echo "✓ Built $OUT"

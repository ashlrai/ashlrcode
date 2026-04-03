#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
echo "Building AshlrCode v${VERSION}..."

mkdir -p dist

# Build for current platform
echo "  Building for current platform..."
bun build src/cli.ts --compile --outfile "dist/ac"
chmod +x dist/ac

echo "  Binary size: $(du -sh dist/ac | cut -f1)"
echo "  Testing binary..."
./dist/ac --version 2>/dev/null || echo "  (no --version flag yet)"

echo ""
echo "Build complete: dist/ac"
echo "Install globally: cp dist/ac /usr/local/bin/ac"

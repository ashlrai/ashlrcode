#!/bin/bash
# Bifrost Proxy Setup — Route Claude Code through xAI Grok
#
# This script starts Bifrost and configures Claude Code to use xAI Grok
# as the model provider. Use this when you've run out of Claude Code usage.
#
# Prerequisites:
#   - XAI_API_KEY environment variable set
#   - npx available (comes with Node.js)
#
# Usage:
#   ./scripts/bifrost-setup.sh         # Start Bifrost proxy
#   Then in another terminal:
#   ANTHROPIC_BASE_URL=http://localhost:8080/anthropic claude   # Use Claude Code with Grok

set -e

echo "🔗 AshlrCode Bifrost Proxy"
echo "=========================="
echo ""

# Check for xAI API key
if [ -z "$XAI_API_KEY" ]; then
  echo "❌ XAI_API_KEY not set. Get one at https://console.x.ai/"
  exit 1
fi

echo "✓ XAI_API_KEY found"
echo ""

# Check for npx
if ! command -v npx &> /dev/null; then
  echo "❌ npx not found. Install Node.js first."
  exit 1
fi

echo "Starting Bifrost on http://localhost:8080..."
echo ""
echo "To use Claude Code with Grok, open a new terminal and run:"
echo ""
echo "  export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic"
echo "  export ANTHROPIC_API_KEY=dummy-key"
echo "  claude"
echo ""
echo "Or for the Agent SDK (ashlr-cmo, etc.):"
echo ""
echo "  ANTHROPIC_BASE_URL=http://localhost:8080/anthropic ANTHROPIC_API_KEY=dummy-key bun run src/index.ts"
echo ""
echo "Press Ctrl+C to stop."
echo ""

npx -y @maximhq/bifrost

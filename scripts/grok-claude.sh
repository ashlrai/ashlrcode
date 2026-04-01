#!/bin/bash
# Quick alias: Run Claude Code with xAI Grok via Bifrost
#
# Assumes Bifrost is running on localhost:8080
# Start Bifrost first: ./scripts/bifrost-setup.sh
#
# Usage: ./scripts/grok-claude.sh [claude-code-args...]

export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic
export ANTHROPIC_API_KEY=dummy-key

echo "🔄 Using Claude Code → Bifrost → xAI Grok"
echo ""

claude "$@"

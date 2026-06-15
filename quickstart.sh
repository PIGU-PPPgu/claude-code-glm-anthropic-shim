#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "== CC GLM Dynamic Shim quickstart =="

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js >= 18 is required. Install Node.js first." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required. Current: $(node --version)" >&2
  exit 1
fi

echo "Node: $(node --version)"
echo
echo "Running tests..."
npm test

echo
echo "Installing macOS LaunchAgent..."
./install-launchagent.sh

echo
echo "Checking shim health..."
./status.sh

cat <<'EOF'

Next step: configure Claude Code or ccswitch.

Use these values:

ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
ANTHROPIC_AUTH_TOKEN=<your BigModel Coding Plan API key>
ANTHROPIC_MODEL=glm-5.2
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1M]
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1M]
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2
CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
CLAUDE_CODE_SUBAGENT_MODEL=glm-5.2
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

Shim runtime defaults:

GLM_SHIM_MAX_CONCURRENT=3
GLM_SHIM_MAX_RETRIES=5
GLM_SHIM_RETRY_BASE_MS=2000
GLM_SHIM_UPSTREAM_TIMEOUT_MS=300000

Then restart Claude Code and run:

/effort ultracode
ultracode: start the smallest possible real dynamic workflow. One workflow, one tiny agent, no file edits. Final answer exactly OK.
/workflows
EOF

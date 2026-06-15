#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export GLM_MODEL="${GLM_MODEL:-glm-5.2}"
export GLM_SHIM_THINKING="${GLM_SHIM_THINKING:-enabled}"
export GLM_SHIM_MAX_CONCURRENT="${GLM_SHIM_MAX_CONCURRENT:-3}"
export GLM_SHIM_MAX_RETRIES="${GLM_SHIM_MAX_RETRIES:-5}"
export GLM_SHIM_RETRY_BASE_MS="${GLM_SHIM_RETRY_BASE_MS:-2000}"
export GLM_SHIM_UPSTREAM_TIMEOUT_MS="${GLM_SHIM_UPSTREAM_TIMEOUT_MS:-300000}"
export PORT="${PORT:-8787}"

exec npm start

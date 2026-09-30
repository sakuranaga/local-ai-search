#!/usr/bin/env bash
# Start the OCR server with Surya.
# Usage: ./start.sh [port]
# Set LLAMA_CPP_BINARY to a GPU-enabled llama-server build if not on PATH.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8090}"

# Activate venv if present
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# Surya v2 runs recognition in llama-server; torch is only used on CPU.
export TORCH_DEVICE="${TORCH_DEVICE:-cpu}"
export SURYA_INFERENCE_BACKEND="${SURYA_INFERENCE_BACKEND:-llamacpp}"

echo "Starting OCR server on port ${PORT} (backend: ${SURYA_INFERENCE_BACKEND})..."
exec uvicorn server:app --host 0.0.0.0 --port "$PORT"

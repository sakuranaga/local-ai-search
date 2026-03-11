#!/usr/bin/env bash
# Start the OCR server with Surya.
# Usage: ./start.sh [port]
# Set TORCH_DEVICE=cuda to use GPU (requires ROCm/CUDA compatible PyTorch).

set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8090}"

# Activate venv if present
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# AMD GPU stability settings
export HSA_ENABLE_SDMA="${HSA_ENABLE_SDMA:-0}"
export AMD_SERIALIZE_KERNEL="${AMD_SERIALIZE_KERNEL:-3}"
export ROCM_FORCE_DISABLE_LAZY_ALLOC="${ROCM_FORCE_DISABLE_LAZY_ALLOC:-1}"
export TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL="${TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL:-1}"

# Fix batch size to avoid ROCm kernel recompilation for different tensor shapes
export RECOGNITION_BATCH_SIZE="${RECOGNITION_BATCH_SIZE:-64}"
export DETECTOR_BATCH_SIZE="${DETECTOR_BATCH_SIZE:-8}"

# Default to GPU (set TORCH_DEVICE=cpu if no compatible GPU available)
export TORCH_DEVICE="${TORCH_DEVICE:-cuda}"

echo "Starting OCR server on port ${PORT} (device: ${TORCH_DEVICE})..."
exec uvicorn server:app --host 0.0.0.0 --port "$PORT"

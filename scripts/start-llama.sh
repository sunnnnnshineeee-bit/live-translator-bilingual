#!/usr/bin/env bash
# ============================================================
# Start llama-server with the Qwen3-4B translation model.
# Serves the OpenAI-compatible API on 127.0.0.1:8080.
#
# -np 2  ->  2 parallel slots (server allows up to 3 concurrent
#            translations; 2 slots keeps CPU load manageable)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x "./llama/llama-server" ]; then
  echo "llama-server not found at ./llama/llama-server"
  echo "macOS:   brew install llama.cpp   (then edit this script to use the brewed binary)"
  echo "         or build from https://github.com/ggml-org/llama.cpp"
  exit 1
fi

exec ./llama/llama-server \
  -m models/Qwen3-4B-Q4_K_M.gguf \
  -c 4096 \
  -np 2 \
  -t 8 \
  --host 127.0.0.1 \
  --port 8080

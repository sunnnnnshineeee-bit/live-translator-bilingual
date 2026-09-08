#!/usr/bin/env bash
# ============================================================
# Download the three model files required by live-translator.
# Total ~3.4 GB.
# Tries hf-mirror.com first (fast in CN), falls back to
# huggingface.co. Safe to re-run: existing files are skipped,
# partial downloads resume automatically (-C -).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

MIRROR="https://hf-mirror.com"
HF="https://huggingface.co"

fetch() {
  local url_path="$1"
  local out="$2"

  if [ -s "$out" ]; then
    echo "[skip] $out already exists"
    return 0
  fi

  echo "[down] $out"
  mkdir -p "$(dirname "$out")"

  curl -L -C - --fail -o "$out" "$MIRROR/$url_path" \
    || curl -L -C - --fail -o "$out" "$HF/$url_path"

  echo "[done] $out"
}

# 1. Whisper speech recognition model (574 MB)
fetch \
  "ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" \
  "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"

# 2. Silero VAD model (864 KB) — kills silence/noise hallucinations
fetch \
  "ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin" \
  "whisper.cpp/models/ggml-silero-v6.2.0.bin"

# 3. Qwen3-4B translation model (2.3 GB)
fetch \
  "Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf" \
  "models/Qwen3-4B-Q4_K_M.gguf"

echo ""
echo "All models ready."

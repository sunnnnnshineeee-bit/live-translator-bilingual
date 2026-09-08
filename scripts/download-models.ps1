# ============================================================
# Download the three model files required by live-translator.
# Total ~1.6 GB.
# Tries hf-mirror.com first (fast in CN), falls back to
# huggingface.co. Safe to re-run: existing files are skipped,
# partial downloads resume automatically (-C -).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$mirror = "https://hf-mirror.com"
$hf = "https://huggingface.co"

function Fetch($path, $out) {
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) {
    Write-Host "[skip] $out already exists"
    return
  }
  Write-Host "[down] $out"
  $dir = Split-Path $out -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  curl.exe -L -C - --fail -o $out "$mirror/$path"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "mirror failed, trying huggingface.com ..."
    curl.exe -L -C - --fail -o $out "$hf/$path"
    if ($LASTEXITCODE -ne 0) {
      throw "download failed: $path"
    }
  }
  Write-Host "[done] $out"
}

# 1. Whisper speech recognition model (574 MB)
Fetch "ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" `
      "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"

# 2. Silero VAD model (864 KB) - kills silence/noise hallucinations
Fetch "ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin" `
      "whisper.cpp/models/ggml-silero-v6.2.0.bin"

# 3. Qwen3-1.7B translation model (1.0 GB) - chosen over 4B because
#    it is much faster on CPU-only machines (typical Windows PC).
#    Official Qwen repo only publishes Q8_0 for 1.7B, so we use
#    unsloth's Q4_K_M quantization.
Fetch "unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf" `
      "models/Qwen3-1.7B-Q4_K_M.gguf"

Write-Host ""
Write-Host "All models ready."

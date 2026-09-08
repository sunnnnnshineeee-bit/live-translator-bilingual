# ============================================================
# Download the three model files required by live-translator.
# Total ~1.6 GB.
# Tries hf-mirror.com first (fast in CN), falls back to
# huggingface.co. Safe to re-run: complete files are skipped,
# partial downloads resume automatically (-C -) and file sizes
# are verified against the server, so a truncated file is
# always detected and completed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$mirror = "https://hf-mirror.com"
$hf = "https://huggingface.co"

# Expected sizes (bytes), used to verify completeness.
$sizes = @{
  "ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" = 574041195
  "ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"        = 885098
  "unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"     = 1107409472
}

function Fetch($path, $out) {
  $expected = $sizes[$path]

  if ($expected -gt 0 -and (Test-Path $out) -and ((Get-Item $out).Length -eq $expected)) {
    Write-Host "[skip] $out already exists (size verified)"
    return
  }

  $have = 0
  if (Test-Path $out) { $have = (Get-Item $out).Length }
  if ($have -gt 0) {
    Write-Host "[resume] $out is incomplete ($have of $expected bytes) - continuing"
  } else {
    Write-Host "[down] $out ($expected bytes)"
  }
  $dir = Split-Path $out -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # Try each source up to 5 times; -C - resumes partial downloads,
  # so a dropped connection just continues on the next attempt.
  foreach ($src in @($mirror, $hf)) {
    for ($i = 1; $i -le 5; $i++) {
      curl.exe -L -C - --fail --connect-timeout 20 -o $out "$src/$path"
      if ($LASTEXITCODE -eq 0 -and (Test-Path $out) -and ((Get-Item $out).Length -eq $expected)) {
        Write-Host "[done] $out (size verified)"
        return
      }
      if (Test-Path $out) { $have = (Get-Item $out).Length }
      Write-Host "attempt $i via $src incomplete (curl exit $LASTEXITCODE, $have of $expected bytes) - resuming in 5s ..."
      Start-Sleep -Seconds 5
    }
  }
  throw "download failed: $path (got $have of $expected bytes)"
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

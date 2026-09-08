# ============================================================
# Start llama-server with the Qwen3-1.7B translation model.
# Serves the OpenAI-compatible API on 127.0.0.1:8080.
# 1.7B is used instead of 4B because it is ~2.5x faster on
# CPU-only machines, at a small quality cost that is fine
# for short subtitle sentences.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-llama.ps1
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$exe = ".\llama\llama-server.exe"
if (-not (Test-Path $exe)) {
  Write-Host "llama-server.exe not found in .\llama\"
  Write-Host ""
  Write-Host "Download the latest Windows build from:"
  Write-Host "  https://github.com/ggml-org/llama.cpp/releases"
  Write-Host "  (file named like llama-bXXXX-bin-win-cpu-x64.zip)"
  Write-Host "  and unzip ALL of its files into the .\llama\ folder."
  exit 1
}

$cores = [Environment]::ProcessorCount
# llama-server shares the CPU with whisper — give it half the
# logical cores (min 2) so the two processes stop fighting.
$threads = [Math]::Max(2, [int]($cores / 2))
Write-Host "Logical processors: $cores -> llama-server threads: $threads"

& $exe `
  -m models/Qwen3-1.7B-Q4_K_M.gguf `
  -c 4096 `
  -np 2 `
  -t $threads `
  --host 127.0.0.1 `
  --port 8080

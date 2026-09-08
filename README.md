# Live Translator — 实时双语直播字幕 / Real-time Bilingual Live Subtitles

麦克风 → **Whisper.cpp**（语音识别）→ **Qwen3**（本地翻译，llama.cpp）→ 浏览器字幕层（可直接作为 OBS 浏览器源）。

Microphone → **Whisper.cpp** (speech recognition) → **Qwen3** (local translation via llama.cpp) → browser subtitle overlay (usable directly as an OBS browser source).

全程本地运行，不依赖任何云服务 / API key。

Runs entirely on your machine — no cloud services, no API keys.

> ### 写给朋友的话 / A Note for My Friend
>
> 朋友你好呀！这个小东西是我连着好几个晚上一点点抠出来的——从语音幻听到翻译复读，每个功能都是踩坑踩出来的。安装哪一步卡住了别慌，随时来找我。祝你直播顺利！
>
> Hey friend! I built this little thing over quite a few late nights — every feature was hard-won, from chasing audio hallucinations to taming translation loops. If you get stuck on any step, don't panic — just come find me. Good luck with your streams!
>
> —— sunnnnnshineeee

```
┌──────────┐   16kHz WAV    ┌─────────────┐   文本/JSON    ┌──────────────┐
│ 浏览器麦克风 │ ──WebSocket──▶ │  server.ts   │ ───────────▶ │  llama-server  │
│ (App.tsx)  │   1.5s 滑动窗口 │  (端口 3001)  │   HTTP       │ (端口 8080)    │
└──────────┘                └─────────────┘              └──────────────┘
      ▲                             │                          │
      │      whisper-cli (3s 窗口 + VAD)                        │
      │                             ▼                          ▼
      │                     ┌──────────────┐          翻译结果回来后
      └──── 广播字幕 ────────│  /overlay 页面 │ ◀── 替换原文（渐进入幕）
                             └──────────────┘
```

## 特性 / Features

- **渐进入幕**：Whisper 中间结果先上屏（~1.8 秒），翻译完成后自动替换为双语
  **Progressive display**: interim Whisper text appears first (~1.8 s), then is automatically replaced by the bilingual subtitle once translation completes
- **反幻听三件套**：VAD + RMS 静音门限 + 第三语言过滤，抑制无声切片时的幻听
  **Anti-hallucination trio**: VAD + RMS silence gate + third-language filtering — no ghost subtitles during silence
- **自动双向**：中文 ⇄ 英文自动检测方向，也可手动锁定
  **Auto bidirectional**: Chinese ⇄ English direction is detected automatically, or can be locked manually
- **智能断句**：标点优先，停顿 1.2 秒自动提交
  **Smart segmentation**: punctuation first; a 1.2 s pause auto-submits the sentence
- **复读克星**：方向守卫检测到"原样复读"自动强制重译
  **Repetition killer**: a direction guard detects same-language echo output and forces a re-translation

---

## 硬件要求 / Hardware Requirements

| 项目 / Item | 要求 / Requirement |
|---|---|
| 内存 / Memory | **8 GB**（Windows：Whisper ~1.5 GB + Qwen3-1.7B ~1.5 GB + 系统）；macOS 用 4B 时建议 16 GB<br>**8 GB** (Windows: Whisper ~1.5 GB + Qwen3-1.7B ~1.5 GB + OS); 16 GB recommended on macOS with the 4B model |
| CPU | 8 线程以上（Apple Silicon M 系列或近几年的 x86 桌面 CPU）<br>8+ threads (Apple Silicon M series, or a recent x86 desktop CPU) |
| 磁盘 / Disk | ~3.5 GB（Windows）；macOS 用 4B 时 ~5 GB<br>~3.5 GB (Windows); ~5 GB on macOS with the 4B model |
| 系统 / OS | macOS（Apple Silicon）或 Windows 10/11 64 位<br>macOS (Apple Silicon) or Windows 10/11 64-bit |

> **中文**：纯 CPU 可运行。翻译模型分两档：**Windows 脚本默认 Qwen3-1.7B**（CPU 快），**macOS 脚本默认 Qwen3-4B**（走 Metal GPU，质量更好）。想互换只改脚本里一行模型名。有 N 卡的话强烈建议去 llama.cpp Releases 下载 `-cuda` 版本，比 CPU 快一个量级。
>
> **English**: Runs fine on pure CPU. Two translation model tiers: the **Windows scripts default to Qwen3-1.7B** (fast on CPU), the **macOS scripts default to Qwen3-4B** (Metal GPU, better quality). Swapping is a one-line change in the script. If you have an NVIDIA GPU, strongly consider the `-cuda` build of llama.cpp from its Releases page — an order of magnitude faster than CPU.

## 软件前置 / Software Prerequisites

- **Node.js ≥ 20**：<https://nodejs.org>
- **Git**：<https://git-scm.com>
- **CMake** + C++ 编译器（用来编译 whisper.cpp）/ C++ compiler (to build whisper.cpp)
  - macOS：`xcode-select --install` 然后 `brew install cmake` / then `brew install cmake`
  - Windows：安装 [Visual Studio 2022 Community](https://visualstudio.microsoft.com/)（勾选 **"使用 C++ 的桌面开发"** 工作负载，自带 CMake）/ install [Visual Studio 2022 Community](https://visualstudio.microsoft.com/) (check the **"Desktop development with C++"** workload; CMake is included)

---

## 安装步骤 / Installation

以下命令都在项目根目录执行。
All commands below run in the project root.

### 1. 克隆本仓库并安装依赖 / Clone the repo and install dependencies

macOS 用终端、Windows 用 PowerShell，命令完全相同。
Use Terminal (macOS) or PowerShell (Windows) — the commands are identical on both platforms.

```bash
git clone https://github.com/sunnnnnshineeee-bit/live-translator-bilingual.git
cd live-translator-bilingual
npm install
```

### 2. 下载模型（一次性）/ Download the models (one-time)

模型文件不进 git，用脚本下载（hf-mirror.com 优先，海外自动回退 HuggingFace，支持断点续传）。
Model files are not stored in git — download them with the scripts (hf-mirror.com first, automatic fallback to HuggingFace, resumable).

**macOS / Linux：**（~3.4 GB，含 Qwen3-4B / includes Qwen3-4B）

```bash
bash scripts/download-models.sh
```

**Windows（PowerShell）：**（~1.1 GB，含 Qwen3-1.7B，CPU 友好 / includes Qwen3-1.7B, CPU-friendly）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1
```

下载完成后 / After downloading:

- `whisper.cpp/models/ggml-base-q5_1.bin` — 语音识别（Windows 用小模型保证实时）/ speech recognition（57 MB，Windows uses the small model for real-time speed）
- `whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin` — 语音识别（macOS）/ speech recognition on macOS（574 MB，仅 macOS 下载 / macOS only）
- `whisper.cpp/models/ggml-silero-v6.2.0.bin` — VAD 静音检测 / VAD silence detection（864 KB）
- `models/Qwen3-4B-Q4_K_M.gguf` — 翻译（macOS）/ translation（2.3 GB）
- `models/Qwen3-1.7B-Q4_K_M.gguf` — 翻译（Windows）/ translation（1.0 GB）

> Windows 默认用小识别模型（纯 CPU 跑大模型跟不上实时）。机器性能好想要更高精度：把 `ggml-large-v3-turbo-q5_0.bin` 下到 `whisper.cpp/models/`，然后这样启动后端 / On a strong machine, download the large model and start the backend like this:
>
> ```powershell
> $env:WHISPER_MODEL="whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"
> npx tsx server.ts
> ```

### 3. 编译 whisper.cpp / Build whisper.cpp

**macOS / Linux（终端 / Terminal）：**

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build -j
cd ..
```

**Windows（PowerShell）：**

```powershell
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release
cd ..
```

> **中文**：Windows 可以**跳过编译这一步**，不用装 Visual Studio 和 CMake——到 <https://github.com/ggml-org/whisper.cpp/releases> 下载编译好的 `whisper-bin-x64.zip`（仅约 8 MB），把 zip 放到项目根目录，执行下面一条命令即可。上面的 `git clone whisper.cpp` 也可以跳过（模型下载脚本会自动建目录）：
>
> ```powershell
> Expand-Archive .\whisper-bin-x64.zip -DestinationPath whisper.cpp\build\bin
> ```
>
> **English**: On Windows you can **skip the build entirely** — no Visual Studio, no CMake. Download the prebuilt `whisper-bin-x64.zip` (~8 MB) from <https://github.com/ggml-org/whisper.cpp/releases>, put the zip in the project root, and run the command above: it places `whisper-cli.exe` (with all its DLLs) exactly where the server looks for it. The `git clone whisper.cpp` step can be skipped too — the model download script creates the folders it needs.

- macOS 产物 / build output：`whisper.cpp/build/bin/whisper-cli`
- Windows 产物 / build output：`whisper.cpp/build/bin/Release/whisper-cli.exe`

### 4. 准备 llama.cpp（跑翻译模型）/ Set up llama.cpp (runs the translation model)

**Windows**：到 <https://github.com/ggml-org/llama.cpp/releases> 下载最新的 `llama-bXXXX-bin-win-cpu-x64.zip`，把压缩包里**全部文件**解压到项目的 `llama\` 文件夹（没有就新建）。
Download the latest `llama-bXXXX-bin-win-cpu-x64.zip` from <https://github.com/ggml-org/llama.cpp/releases> and extract **all files** into the project's `llama\` folder (create it if it doesn't exist).

**macOS**：`brew install llama.cpp` 或自行编译，确保 `llama/llama-server` 存在（本仓库的启动脚本按此路径找）。
Run `brew install llama.cpp` or build it yourself — make sure `llama/llama-server` exists (the startup scripts look for it there).

---

## 运行（需要开 3 个终端）/ Running (3 terminals)

**终端 1：翻译模型服务（占用 8080 端口）/ Terminal 1 — translation model server (port 8080):**

macOS / Linux：

```bash
bash scripts/start-llama.sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-llama.ps1
```

**终端 2：字幕后端（占用 3001 端口，两平台相同）/ Terminal 2 — subtitle backend (port 3001, same on both platforms):**

```bash
npx tsx server.ts
```

**终端 3：前端（两平台相同）/ Terminal 3 — frontend (same on both platforms):**

```bash
npm run dev
```

打开 <http://localhost:5173> / Open <http://localhost:5173>:

1. 允许麦克风权限，选择麦克风 / Allow microphone access and pick your microphone
2. 语言选 **"自动（英↔中 双向）"** / Set the language to **"Auto (English ↔ Chinese, bidirectional)"**
3. 点 **Start Translation**，开始说话 / Click **Start Translation** and start talking

### OBS 字幕 / OBS Subtitles

1. OBS → 添加 **浏览器源** / In OBS, add a **Browser source**
2. URL 填 `http://localhost:5173/overlay`，宽 1200 高 300 / Set the URL to `http://localhost:5173/overlay`, width 1200, height 300
3. 说话时字幕自动出现，支持原文 + 译文双语显示 / Subtitles appear automatically as you speak — original text plus translation

> 直播结束点 **Stop Translation**（会触发 flush，把最后半句提交翻译后再退出）。
> When your stream ends, click **Stop Translation** — it triggers a flush that submits the last half-sentence before shutting down.

---

## 项目结构 / Project Structure

```
├── server.ts            # 后端：音频队列、断句、翻译调度、WebSocket 广播
│                        # Backend: audio queue, segmentation, translation scheduling, WebSocket broadcast
├── whisperService.ts    # whisper-cli 子进程封装 / whisper-cli subprocess wrapper
├── audioUtils.ts        # 音频工具 / audio utilities
├── src/
│   ├── App.tsx          # 控制面板（麦克风、语言、字幕预览）/ control panel (mic, language, preview)
│   ├── Overlay.tsx      # OBS 字幕层（/overlay 路由）/ OBS subtitle layer (/overlay route)
│   └── services/        # AudioRecorder（16kHz 采集 + 滑动窗口切片）/ 16 kHz capture + sliding window
├── scripts/
│   ├── download-models.sh / .ps1   # 模型下载（hf-mirror 优先）/ model download (hf-mirror first)
│   └── start-llama.sh / .ps1       # llama-server 启动 / llama-server startup
├── whisper.cpp/         # （本地克隆+编译，不进 git）/ cloned + built locally, not in git
├── models/              # Qwen 模型（不进 git）/ Qwen models, not in git
└── llama/               # llama-server 二进制（不进 git）/ llama-server binaries, not in git
```

## 故障排查 / Troubleshooting

| 症状 / Symptom | 原因 / 解决 / Cause & Fix |
|---|---|
| 改了 server.ts 没生效<br>Edited server.ts but nothing changed | **tsx 不热重载**，Ctrl+C 后重新 `npx tsx server.ts`<br>**tsx has no hot reload** — press Ctrl+C and rerun `npx tsx server.ts` |
| Overlay 一片空白<br>Overlay is blank | 确认三个终端都开着；浏览器 F12 看 Console 报错<br>Make sure all three terminals are running; check the browser console (F12) |
| 翻译一直转不出来<br>Translation never arrives | llama-server 没起来或 8080 被占用：`curl http://127.0.0.1:8080/health`<br>llama-server isn't running or port 8080 is occupied |
| 无声时出幻听字幕<br>Ghost subtitles during silence | 检查 `whisper.cpp/models/ggml-silero-v6.2.0.bin` 是否下载成功<br>Check that the silero VAD model downloaded successfully |
| 识别结果完全不对，凭空出现"他开始说话了""Now I'm going to start writing"这类没人说过的话<br>Recognition is completely wrong, outputs phrases nobody said | 你的声音根本没进音频流——浏览器采错了麦克风。在页面里的设备下拉选对麦克风；再检查 Chrome/Edge 地址栏的麦克风图标。对着页面说话看音量条：基本不动就是采错设备（也查一下 Windows 设置 → 隐私 → 麦克风）<br>Your voice is not reaching the app — wrong microphone. Pick the correct mic in the app's device dropdown and check the mic icon in the address bar; if the volume bar barely moves, Windows is capturing the wrong device |
| 连续说话越来越卡<br>Gets laggier the longer you talk | 现在会自动丢弃积压的旧音频（终端会出现 "Dropped N stale audio chunks"），慢 CPU 上延迟也有上限。仍慢就关掉占 CPU 的程序，或把 start-llama 里 `-np 2` 改成 `-np 1`<br>Stale audio chunks are now dropped automatically, so latency stays bounded even on slow CPUs. If still slow, close CPU-heavy apps or change `-np 2` to `-np 1` in start-llama |
| 端口冲突<br>Port conflicts | 3001（后端）/ 8080（llama）/ 5173（前端）被占用时改对应配置<br>Adjust the corresponding config when 3001 / 8080 / 5173 is occupied |

## 已知限制 / Known Limitations

- 识别语言仅支持中文、英文（其他语言按幻觉过滤丢弃）
  Recognition supports Chinese and English only (other languages are filtered out as hallucinations)
- Windows 默认用小的 `base-q5_1` 识别模型（纯 CPU 保证实时），精度略低于 macOS 用的 `large-v3-turbo`（升级方法见第 2 步的说明）
  Windows uses the smaller `base-q5_1` recognition model by default for real-time speed on CPU; accuracy is somewhat below the macOS `large-v3-turbo` (see the note in Step 2 to upgrade)
- Windows 纯 CPU + 1.7B 模型下，译文总延迟约 **3–5 秒**（原文渐进入幕 ~2 秒先出）；有 N 卡装 CUDA 版 llama.cpp 可降到 ~2 秒
  On pure-CPU Windows with the 1.7B model, total subtitle latency is about **3–5 s** (original text appears in ~2 s via progressive display); an NVIDIA GPU with the CUDA build brings it down to ~2 s
- 1.7B 翻译质量略低于 4B，短句基本无差别，长难句偶有不顺；偶发繁体中文输出（方向守卫会兜底重试）。追求质量可在 Windows 上也改用 4B（下载脚本里换成 4B 的文件名即可，内存需 16 GB）
  The 1.7B model's translation quality is slightly below the 4B's; long, difficult sentences occasionally come out awkwardly or in Traditional Chinese (the direction guard retries as a fallback). For best quality, switch to the 4B model on Windows too (one line in the download script; needs 16 GB RAM)
- 浏览器要求桌面版 Chrome / Edge（ScriptProcessorNode + WebSocket）
  Requires a desktop Chrome / Edge browser (ScriptProcessorNode + WebSocket)

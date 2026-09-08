import { spawn } from "child_process"
import os from "os"

const WHISPER_CLI =
  process.env.WHISPER_CLI
    ? process.env.WHISPER_CLI
    : process.platform === "win32"
      ? "./whisper.cpp/build/bin/Release/whisper-cli.exe"
      : "./whisper.cpp/build/bin/whisper-cli"

// Speech recognition model. Windows defaults to the much smaller
// base model — large-v3-turbo cannot run in real time on a pure
// CPU PC. Override with the WHISPER_MODEL env var, e.g.:
//   WHISPER_MODEL=./whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin
const WHISPER_MODEL =
  process.env.WHISPER_MODEL
    ? process.env.WHISPER_MODEL
    : process.platform === "win32"
      ? "./whisper.cpp/models/ggml-base-q5_1.bin"
      : "./whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"

// ------------------------------------------------------------
// CPU 线程数：whisper 和 llama-server 同时跑、共享同一颗 CPU。
// 线程数超过逻辑核心数（比如 4 核机器上开 8 线程）会让两边
// 互相踩踏、都变慢，所以按实际核心数来，可用
// WHISPER_THREADS=8 环境变量覆盖。
// ------------------------------------------------------------

const WHISPER_THREADS =
  process.env.WHISPER_THREADS
    ? process.env.WHISPER_THREADS
    : String(
        Math.min(
          8,
          Math.max(
            2,
            os.cpus().length,
          ),
        ),
      )
  
export type WhisperLanguage =
  | "auto"
  | "zh"
  | "en"

export function transcribeAudio(
  audioFile: string,
  language: WhisperLanguage = "auto",
): Promise<string> {
  return new Promise((resolve, reject) => {
  const args = [
  "-m",
  WHISPER_MODEL,
  "-f",
  audioFile,

      // ------------------------------------------------
      // 语言
      // ------------------------------------------------

      "-l",
      language,

      // ------------------------------------------------
      // 不输出时间戳
      // ------------------------------------------------

      "-nt",

      // ------------------------------------------------
      // 实时字幕优化
      // ------------------------------------------------

      //"-sow",
      // ------------------------------------------------
      // VAD：无声/噪音切片直接跳过识别
      // （已实测：白噪音不再幻觉出 "Okay."，
      //   无声切片耗时 1.1s → 0.28s）
      // ------------------------------------------------

      "--vad",
      "--vad-model",
      "./whisper.cpp/models/ggml-silero-v6.2.0.bin",

      // ------------------------------------------------
      // CPU 线程：按机器核心数自动匹配
      // （whisper 和 llama-server 同时运行，超订线程
      //   只会让两个进程互相抢 CPU）
      // ------------------------------------------------

      "-t",
      WHISPER_THREADS,
      "-mc",
      "0",

      "-ml",
      "0",

      "-nth",
      "0.5",

      "-sns",
    ]

    console.log(
      `Starting Whisper (${language})...`,
    )

    const whisper = spawn(
      WHISPER_CLI,
      args,
      {
        cwd: process.cwd(),
      },
    )

    let output = ""
    let errorOutput = ""

    whisper.stdout.on(
      "data",
      (data) => {
        output += data.toString()
      },
    )

    whisper.stderr.on(
      "data",
      (data) => {
        errorOutput += data.toString()
      },
    )

    whisper.on(
      "error",
      (error) => {
        reject(error)
      },
    )

    whisper.on(
      "close",
      (code) => {
        if (code !== 0) {
          console.error(
            errorOutput,
          )

          // 3221225781 = 0xC0000135 (Windows: DLL not found).
          // whisper-cli.exe must sit next to its whisper.dll /
          // ggml.dll, and the system needs the VC++ runtime.
          const hint =
            code === 3221225781
              ? " (0xC0000135: DLL not found. whisper-cli.exe needs whisper.dll and ggml.dll in the SAME folder — re-extract whisper-bin-x64.zip into whisper.cpp\\build\\bin. If the DLLs are there, install the VC++ Redistributable x64: https://aka.ms/vs/17/release/vc_redist.x64.exe)"
              : ""

          reject(
            new Error(
              `Whisper exited with code ${code}${hint}`,
            ),
          )

          return
        }

        console.log(
          "Whisper output:",
        )

        console.log(output)

        const text =
          output
            .trim()
            .split("\n")
            .map((line) =>
              line.trim(),
            )
            .filter(Boolean)
            .filter(
              (line) =>
                !line.startsWith(
                  "whisper_",
                ) &&
                !line.startsWith(
                  "main:",
                ) &&
                !line.startsWith(
                  "system_info:",
                ),
            )
            .join(" ")
            .trim()

        resolve(text)
      },
    )
  })
}
import recorder from "node-record-lpcm16"
import fs from "fs"
import { spawn } from "child_process"

const outputFile = "/tmp/live-translator-test.wav"

console.log("开始录音...")
console.log("请说一句话，5 秒后自动停止。")

const recording = recorder.record({
  sampleRate: 16000,
  channels: 1,
  audioType: "wav",
})

const file = fs.createWriteStream(outputFile)

recording.stream().pipe(file)

setTimeout(() => {
  console.log("停止录音...")

  recording.stop()

  file.on("finish", () => {
    console.log("录音完成：", outputFile)
    console.log("开始 Whisper 识别...")

    const whisper = spawn(
      "./whisper.cpp/build/bin/whisper-cli",
      [
        "-m",
        "./whisper.cpp/models/ggml-tiny.bin",
        "-f",
        outputFile,
        "-l",
        "auto",
        "-nt",
      ],
    )

    let output = ""

    whisper.stdout.on("data", (data) => {
      output += data.toString()
    })

    whisper.stderr.on("data", (data) => {
      process.stderr.write(data)
    })

    whisper.on("close", (code) => {
      console.log("\n========== Whisper RESULT ==========")
      console.log(output)
      console.log("===================================")
      console.log("exit code:", code)
    })
  })
}, 5000)

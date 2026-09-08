import { useEffect, useRef, useState } from "react"
import type { Subtitle, SubtitleMode } from "./types/subtitle"
import { AudioRecorder } from "./services/audioRecorder"

type AppStatus =
  | "ready"
  | "listening"
  | "stopped"
  | "error"

function App() {
  const subtitleSocketRef =
    useRef<WebSocket | null>(null)

  const recorderRef =
    useRef<AudioRecorder | null>(null)

  const [status, setStatus] =
    useState<AppStatus>("ready")

  const [devices, setDevices] =
    useState<MediaDeviceInfo[]>([])

  const [selectedDevice, setSelectedDevice] =
    useState("")

  const [audioLevel, setAudioLevel] =
    useState(0)

  const [errorMessage, setErrorMessage] =
    useState("")

  const [subtitleMode, setSubtitleMode] =
    useState<SubtitleMode>("bilingual")

    const [sourceLanguage, setSourceLanguage] =
  useState<"auto" | "zh" | "en">("auto")

  const [currentSubtitle, setCurrentSubtitle] =
    useState<Subtitle | null>(null)

  const streamRef =
    useRef<MediaStream | null>(null)

  const audioContextRef =
    useRef<AudioContext | null>(null)

  const analyserRef =
    useRef<AnalyserNode | null>(null)

  const animationFrameRef =
    useRef<number | null>(null)

  // ============================
  // Float32 → WAV
  // ============================

  function float32ToWav(
    samples: Float32Array,
    sampleRate = 16000,
  ): ArrayBuffer {
    const buffer =
      new ArrayBuffer(
        44 + samples.length * 2,
      )

    const view =
      new DataView(buffer)

    const writeString = (
      offset: number,
      text: string,
    ) => {
      for (
        let i = 0;
        i < text.length;
        i++
      ) {
        view.setUint8(
          offset + i,
          text.charCodeAt(i),
        )
      }
    }

    writeString(0, "RIFF")

    view.setUint32(
      4,
      36 + samples.length * 2,
      true,
    )

    writeString(8, "WAVE")

    writeString(12, "fmt ")

    view.setUint32(16, 16, true)

    view.setUint16(20, 1, true)

    view.setUint16(22, 1, true)

    view.setUint32(
      24,
      sampleRate,
      true,
    )

    view.setUint32(
      28,
      sampleRate * 2,
      true,
    )

    view.setUint16(32, 2, true)

    view.setUint16(34, 16, true)

    writeString(36, "data")

    view.setUint32(
      40,
      samples.length * 2,
      true,
    )

    let offset = 44

    for (
      let i = 0;
      i < samples.length;
      i++
    ) {
      const sample =
        Math.max(
          -1,
          Math.min(1, samples[i]),
        )

      view.setInt16(
        offset,
        sample < 0
          ? sample * 0x8000
          : sample * 0x7fff,
        true,
      )

      offset += 2
    }

    return buffer
  }

  // ============================
  // 获取麦克风
  // ============================

  const getMicrophones = async () => {
    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        })

      const allDevices =
        await navigator.mediaDevices.enumerateDevices()

      const microphones =
        allDevices.filter(
          (device) =>
            device.kind === "audioinput",
        )

      setDevices(microphones)

      if (
        microphones.length > 0 &&
        !selectedDevice
      ) {
        setSelectedDevice(
          microphones[0].deviceId,
        )
      }

      stream
        .getTracks()
        .forEach((track) =>
          track.stop(),
        )
    } catch (error) {
      console.error(error)

      setStatus("error")

      setErrorMessage(
        "Unable to access microphone. Please allow microphone permission.",
      )
    }
  }

  // ============================
  // 创建字幕
  // ============================

  const createSubtitleFromWhisper = (
    text: string,
  ): Subtitle => {
    return {
      id: `${Date.now()}`,
      timestamp: Date.now(),

      // 暂时没有翻译
      // 所以 original 和 translation
      // 都放 Whisper 原文
      original: text,
      translation: text,

      sourceLanguage: "auto",
      targetLanguage: "auto",
    }
  }

  // ============================
  // 开始麦克风
  // ============================

  const startMicrophone = async () => {
    try {
      setErrorMessage("")

      if (
        !subtitleSocketRef.current ||
        subtitleSocketRef.current.readyState !==
          WebSocket.OPEN
      ) {
        setErrorMessage(
          "WebSocket is not connected. Please refresh the page.",
        )

        return
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: selectedDevice
            ? {
                deviceId: {
                  exact: selectedDevice,
                },
              }
            : true,
        })

      streamRef.current = stream

      const AudioContextClass =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext: typeof AudioContext
          }
        ).webkitAudioContext

      const audioContext =
        new AudioContextClass()

      audioContextRef.current =
        audioContext

      const analyser =
        audioContext.createAnalyser()

      analyser.fftSize = 256

      analyser.smoothingTimeConstant =
        0.8

      analyserRef.current =
        analyser

      const source =
        audioContext.createMediaStreamSource(
          stream,
        )

      source.connect(analyser)

      // ============================
      // AudioRecorder
      // ============================

      const recorder =
        new AudioRecorder()

      recorderRef.current =
        recorder

    const audioBuffer: Float32Array[] = []
let totalSamples = 0

const TARGET_SAMPLES = 16000 * 1.5

let overlapTail: Float32Array | null =
  null

await recorder.start((audio) => {
  audioBuffer.push(audio)
  totalSamples += audio.length

    if (totalSamples >= TARGET_SAMPLES) {
    const fresh = new Float32Array(totalSamples)

    let offset = 0

    for (const chunk of audioBuffer) {
      fresh.set(chunk, offset)
      offset += chunk.length
    }

     audioBuffer.length = 0
    totalSamples = 0

     const samples = new Float32Array(
      (overlapTail?.length ?? 0) +
        fresh.length,
    )

    if (overlapTail) {
      samples.set(overlapTail, 0)
    }

    samples.set(fresh, overlapTail?.length ?? 0)

    // 本段新增部分留作下一段的上下文
    overlapTail = fresh

    // ----------------------------
    // 静音切片直接丢弃
    // ----------------------------

    let sum = 0

    for (
      let i = 0;
      i < samples.length;
      i++
    ) {
      sum +=
        samples[i] *
        samples[i]
    }

    const rms =
      Math.sqrt(
        sum /
          samples.length,
      )

    if (rms < 0.01) {
      console.log("Silent chunk skipped. RMS:", rms.toFixed(4))
      overlapTail = null
      return
    }

    console.log(
  "Sending 1.5 seconds of audio to Whisper...",
)

    const wav = float32ToWav(
      samples,
      16000,
    )

    if (
      subtitleSocketRef.current &&
      subtitleSocketRef.current.readyState ===
        WebSocket.OPEN
    ) {
      subtitleSocketRef.current.send(wav)
    }
  }
}, selectedDevice)

      setStatus("listening")

      // ============================
      // 音量检测
      // ============================

      const dataArray =
        new Uint8Array(
          analyser.frequencyBinCount,
        )

      const updateVolume = () => {
        if (!analyserRef.current) {
          return
        }

        analyserRef.current.getByteTimeDomainData(
          dataArray,
        )

        let sum = 0

        for (
          let i = 0;
          i < dataArray.length;
          i++
        ) {
          const normalized =
            (dataArray[i] - 128) /
            128

          sum +=
            normalized *
            normalized
        }

        const rms =
          Math.sqrt(
            sum /
              dataArray.length,
          )

        const level =
          Math.min(
            100,
            Math.round(
              rms * 500,
            ),
          )

        setAudioLevel(level)

        animationFrameRef.current =
          requestAnimationFrame(
            updateVolume,
          )
      }

      updateVolume()
    } catch (error) {
      console.error(error)

      setStatus("error")

      setErrorMessage(
        "Unable to start microphone. Please check your microphone permission.",
      )
    }
  }

  // ============================
  // 停止麦克风
  // ============================

  const stopMicrophone = () => {
    recorderRef.current?.stop()

    recorderRef.current =
      null

    if (
      animationFrameRef.current !==
      null
    ) {
      cancelAnimationFrame(
        animationFrameRef.current,
      )

      animationFrameRef.current =
        null
    }

    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track) =>
          track.stop(),
        )

      streamRef.current = null
    }

    if (
      audioContextRef.current
    ) {
      audioContextRef.current.close()

      audioContextRef.current =
        null
    }

    analyserRef.current =
      null

    setAudioLevel(0)

    setCurrentSubtitle(null)

    setStatus("stopped")

    // 通知服务器提交最后一句（flush 不会被转发给其他客户端）
    if (
      subtitleSocketRef.current &&
      subtitleSocketRef.current.readyState ===
        WebSocket.OPEN
    ) {
      subtitleSocketRef.current.send(
        JSON.stringify({
          type: "flush",
        }),
      )
    }
  }

  // ============================
  // 初始化 WebSocket
  // ============================

  useEffect(() => {
    getMicrophones()

    const socket =
      new WebSocket(
        "ws://localhost:3001",
      )

    socket.onopen = () => {
      console.log(
        "WebSocket connected",
      )
    }

    // ============================
    // 收到服务器消息
    // ============================

    socket.onmessage = (event) => {
      console.log(
        "WebSocket message:",
        event.data,
      )

      if (
        typeof event.data !==
        "string"
      ) {
        return
      }

      let data: any

      try {
        data = JSON.parse(
          event.data,
        )
      } catch {
        console.warn(
          "Invalid WebSocket JSON:",
          event.data,
        )

        return
      }

      // ============================
      // Whisper 识别结果
      // ============================

      if (
        data.type ===
        "transcription"
      ) {
        const text =
          String(
            data.text ?? "",
          ).trim()

        if (!text) {
          return
        }

        console.log(
          "Received transcription:",
          text,
        )

        const subtitle =
          createSubtitleFromWhisper(
            text,
          )

        setCurrentSubtitle(
          subtitle,
        )
      }

      // ============================
      // 清除字幕
      // ============================

      if (
        data.type === "clear"
      ) {
        setCurrentSubtitle(
          null,
        )
      }

      // ============================
      // 兼容旧 subtitle 消息
      // ============================

      if (
        data.type ===
        "subtitle" &&
        data.subtitle
      ) {
        setCurrentSubtitle(
          data.subtitle,
        )
      }
    }

    socket.onerror = (
      error,
    ) => {
      console.error(
        "WebSocket error:",
        error,
      )
    }

    socket.onclose = () => {
      console.log(
        "WebSocket disconnected",
      )
    }

    subtitleSocketRef.current =
      socket

    return () => {
      if (
        animationFrameRef.current !==
        null
      ) {
        cancelAnimationFrame(
          animationFrameRef.current,
        )
      }

      if (streamRef.current) {
        streamRef.current
          .getTracks()
          .forEach((track) =>
            track.stop(),
          )

        streamRef.current =
          null
      }

      if (
        audioContextRef.current
      ) {
        audioContextRef.current.close()

        audioContextRef.current =
          null
      }

      analyserRef.current =
        null

      if (
        subtitleSocketRef.current
      ) {
        subtitleSocketRef.current.close()

        subtitleSocketRef.current =
          null
      }
    }
  }, [])

  return (
    <div className="app">
      <main className="panel">
        <header className="header">
          <div>
            <h1>
              Live Translator
            </h1>

            <p>
              Real-time bilingual
              subtitles for livestreams
            </p>
          </div>

          <div className="status">
            <span
              className={`status-dot ${
                status === "listening"
                  ? "listening"
                  : ""
              }`}
            />

            {status === "ready" &&
              "Ready"}

            {status ===
              "listening" &&
              "Listening"}

            {status === "stopped" &&
              "Stopped"}

            {status === "error" &&
              "Error"}
          </div>
        </header>

        <section className="section">
          <label>
            MICROPHONE
          </label>

          <select
            className="select"
            value={selectedDevice}
            onChange={(event) => {
              setSelectedDevice(
                event.target.value,
              )

              if (
                status ===
                "listening"
              ) {
                stopMicrophone()
              }
            }}
          >
            {devices.length ===
              0 && (
              <option value="">
                No microphone detected
              </option>
            )}

            {devices.map(
              (
                device,
                index,
              ) => (
                <option
                  key={
                    device.deviceId
                  }
                  value={
                    device.deviceId
                  }
                >
                  {device.label ||
                    `Microphone ${
                      index + 1
                    }`}
                </option>
              ),
            )}
          </select>

          <div className="level-title">
            <span>
              INPUT LEVEL
            </span>

            <span>
              {audioLevel}%
            </span>
          </div>

          <div className="meter">
            <div
              className="meter-fill"
              style={{
                width: `${audioLevel}%`,
              }}
            />
          </div>
        </section>

        <section className="section">
          <label>
            LANGUAGE
          </label>

   <select
  className="select"
  value={sourceLanguage}
  onChange={(event) => {
    const language =
      event.target.value as "auto" | "zh" | "en"

    setSourceLanguage(language)

    if (
      subtitleSocketRef.current &&
      subtitleSocketRef.current.readyState ===
        WebSocket.OPEN
    ) {
      subtitleSocketRef.current.send(
        JSON.stringify({
          type: "settings",
          sourceLanguage: language,
        }),
      )
    }
  }}
>
  <option value="auto">
    自动（英↔中 双向）
  </option>
  <option value="zh">
    中译英（Chinese → English）
  </option>
  <option value="en">
    英译中（English → Chinese）
  </option>
</select>
        </section>

        <section className="section">
          <label>
            TRANSLATION
          </label>

          <div className="direction">
            <span>
              Chinese
            </span>

            <span className="arrow">
              →
            </span>

            <span>
              English
            </span>
          </div>

          <div className="direction-buttons">
            <button>
              Chinese →
              English
            </button>

            <button>
              English →
              Chinese
            </button>
          </div>
        </section>

        <section className="section">
          <label>
            SUBTITLE MODE
          </label>

          <div className="modes">
            <button
              className={
                subtitleMode ===
                "translation"
                  ? "active"
                  : ""
              }
              onClick={() =>
                setSubtitleMode(
                  "translation",
                )
              }
            >
              Translation Only
            </button>

            <button
              className={
                subtitleMode ===
                "bilingual"
                  ? "active"
                  : ""
              }
              onClick={() =>
                setSubtitleMode(
                  "bilingual",
                )
              }
            >
              Bilingual
            </button>

            <button
              className={
                subtitleMode ===
                "original"
                  ? "active"
                  : ""
              }
              onClick={() =>
                setSubtitleMode(
                  "original",
                )
              }
            >
              Original First
            </button>
          </div>
        </section>

        {currentSubtitle && (
          <section className="subtitle-preview">
            <div className="subtitle-label">
              LIVE SUBTITLE
            </div>

            <div className="subtitle-box">
              {subtitleMode !==
                "translation" && (
                <div className="subtitle-original">
                  {
                    currentSubtitle.original
                  }
                </div>
              )}

              {subtitleMode !==
                "original" && (
                <div className="subtitle-translation">
                  {
                    currentSubtitle.translation
                  }
                </div>
              )}
            </div>
          </section>
        )}

        {errorMessage && (
          <div className="error-message">
            {errorMessage}
          </div>
        )}

        {status !== "listening" ? (
          <button
            className="start-button"
            onClick={
              startMicrophone
            }
            disabled={
              !selectedDevice &&
              devices.length === 0
            }
          >
            Start Translation
          </button>
        ) : (
          <button
            className="start-button stop"
            onClick={
              stopMicrophone
            }
          >
            Stop Translation
          </button>
        )}
      </main>
    </div>
  )
}

export default App
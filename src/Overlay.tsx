import { useEffect, useState } from "react"
import type { Subtitle } from "./types/subtitle"

function Overlay() {
  const [subtitle, setSubtitle] =
    useState<Subtitle | null>(null)

  useEffect(() => {
    const socket =
      new WebSocket("ws://127.0.0.1:3001")

    socket.onopen = () => {
      console.log(
        "Overlay WebSocket connected",
      )
    }

    socket.onmessage = (event) => {
      console.log(
        "Overlay received:",
        event.data,
      )

      try {
        const data = JSON.parse(event.data)

        // ============================
        // Whisper 原始识别结果
        // ============================

        if (
          data.type === "whisper" &&
          data.text &&
          data.text !== "[BLANK_AUDIO]"
        ) {
          const newSubtitle: Subtitle = {
            id: `${Date.now()}`,
            timestamp: Date.now(),
            original: data.text,
            translation: "",
            sourceLanguage: "auto",
            targetLanguage: "en",
          }

          setSubtitle(newSubtitle)

          return
        }

        // ============================
        // 正常字幕
        // ============================

        if (data.type === "subtitle") {
          setSubtitle(data.subtitle)

          return
        }

        // ============================
        // 清除字幕
        // ============================

        if (data.type === "clear") {
          setSubtitle(null)

          return
        }
      } catch (error) {
        console.error(
          "Invalid WebSocket message:",
          error,
        )
      }
    }

    socket.onerror = (error) => {
      console.error(
        "Overlay WebSocket error:",
        error,
      )
    }

    socket.onclose = () => {
      console.log(
        "Overlay WebSocket disconnected",
      )
    }

    return () => {
      socket.close()
    }
  }, [])

  return (
    <div className="overlay">
      {subtitle && (
        <div className="overlay-subtitle">

          <div className="overlay-original">
            {subtitle.original}
          </div>

          {subtitle.translation && (
            <div className="overlay-translation">
              {subtitle.translation}
            </div>
          )}

        </div>
      )}
    </div>
  )
}

export default Overlay

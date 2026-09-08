import type { Subtitle } from "../types/subtitle"

const mockSubtitles: Omit<Subtitle, "id" | "timestamp">[] = [
  {
    original: "大家晚上好！",
    translation: "Good evening everyone!",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "欢迎来到我的直播间。",
    translation: "Welcome to my stream.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "今天我们来聊聊音乐。",
    translation: "Today we're going to talk about music.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "你们今天过得怎么样？",
    translation: "How was your day?",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "我刚刚结束了一场直播。",
    translation: "I just finished a stream.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "这个真的非常有意思。",
    translation: "This is really interesting.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "等一下我们会玩一个游戏。",
    translation: "We're going to play a game in a moment.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
  {
    original: "谢谢大家今天来看我的直播。",
    translation: "Thank you everyone for joining my stream today.",
    sourceLanguage: "zh",
    targetLanguage: "en",
  },
]

let currentIndex = 0

export function getNextMockSubtitle(): Subtitle {
  const item = mockSubtitles[currentIndex]

  currentIndex =
    (currentIndex + 1) % mockSubtitles.length

  return {
    ...item,
    id: `${Date.now()}-${currentIndex}`,
    timestamp: Date.now(),
  }
}
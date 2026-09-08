export type Language = "zh" | "en" | "auto"

export type SubtitleMode =
  | "translation"
  | "bilingual"
  | "original"

export interface Subtitle {
  id: string
  original: string
  translation: string
  sourceLanguage: Language
  targetLanguage: Language
  timestamp: number
}
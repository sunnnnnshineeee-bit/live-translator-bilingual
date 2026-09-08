import { WebSocketServer, WebSocket } from "ws"
import { writeFile, unlink } from "fs/promises"
import { transcribeAudio } from "./whisperService"

const PORT = 3001

// ============================================================
// V13
// ============================================================
//
// 目标：
// 1. 只使用一个 Qwen
// 2. 保持原来较低的翻译延迟
// 3. 不因为 Whisper chunk 的短暂停顿而过早翻译
// 4. 尽可能等到一个自然完整的 spoken sentence
//
// 流程：
//
// Microphone
//    ↓
// Whisper
//    ↓
// sentenceBuffer
//    ↓
// ┌─────────────────────────────┐
// │ 有明确句末标点？            │
// │   YES → 立即翻译            │
// │                             │
// │ 没有标点                    │
// │   ↓                         │
// │ 明显残句？                  │
// │   YES → 继续等待            │
// │   NO                        │
// │   ↓                         │
// │ 等待自然停顿 1000ms         │
// │   ↓                         │
// │ 翻译                        │
// └─────────────────────────────┘
//
// 不再使用第二个 AI 判断断句。
// ============================================================


// ============================================================
// 基础设置
// ============================================================

let sourceLanguage:
  | "auto"
  | "zh"
  | "en" = "auto"

const QWEN_URL =
  "http://127.0.0.1:8080/v1/chat/completions"

const QWEN_MODEL =
  "Qwen3-4B-Q4_K_M.gguf"


const wss =
  new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
  })


console.log(
  `WebSocket server running on ws://127.0.0.1:${PORT}`,
)


// ============================================================
// 实时字幕参数
// ============================================================

// ------------------------------------------------------------
// V13：自然停顿多久之后认为一句话可能结束。
//
// 650ms 对直播讲话来说太短。
// 例如：
//
// "I want"
//       ↓ 650ms
// "to show you..."
//
// 很容易被错误拆开。
//
// 1000ms 是一个比较好的起点。
// ------------------------------------------------------------

const SILENCE_FLUSH_MS =1200


// ------------------------------------------------------------
// 一个很短的句子至少需要有多少字符/单词，
// 才允许 silence flush。
//
// 不是硬性的完整句判断。
// 只是防止：
//
// "I want"
// "I think"
// "because"
// "and"
// "so"
//
// 被短暂停顿直接翻译。
// ------------------------------------------------------------

const MIN_WORDS_FOR_SILENCE_FLUSH =
  3


// ------------------------------------------------------------
// Whisper 完全相同结果的重复保护。
// ------------------------------------------------------------

const WHISPER_DUPLICATE_WINDOW =
  1800


// ============================================================
// Generation
// ============================================================
//
// clear 后 generation +1。
// 所有翻译请求记录开始时的 generation。
// 如果请求回来时已经不是当前 generation，
// 直接丢弃。
// ============================================================

let generationId =
  0


// ============================================================
// 音频队列
// ============================================================

type AudioJob = {
  socket: WebSocket
  audio: Buffer
}

const audioQueue:
  AudioJob[] =
  []

let processingAudio =
  false


// ============================================================
// Sentence buffer
// ============================================================

let sentenceBuffer =
  ""

let sentenceSocket:
  WebSocket | null =
  null

let sentenceStartedAt =
  0

let lastWhisperReceivedAt =
  0

let lastWhisperText =
  ""


// ============================================================
// Silence timer
// ============================================================

let silenceFlushTimer:
  ReturnType<typeof setTimeout> | null =
  null


// ============================================================
// Translation state
// ============================================================

let activeTranslations =
  0

// ------------------------------------------------------------
// Keep this in sync with llama-server's -np (2 slots).
// A 3rd concurrent request just queues inside llama-server
// and thrashes the CPU on pure-CPU machines.
// ------------------------------------------------------------

const MAX_PARALLEL_TRANSLATIONS =
  2


type TranslationJob = {
  socket: WebSocket
  text: string
  reason: string
  generation: number
}

const translationQueue:
  TranslationJob[] =
  []


// ============================================================
// Text cleaning
// ============================================================

function cleanText(
  text: string,
): string {

  return text
    .replace(
      /\[BLANK_AUDIO\]/gi,
      "",
    )
    .replace(
      /\[GASP\]/gi,
      "",
    )
    .replace(
      /\[MUSIC\]/gi,
      "",
    )
    .replace(
      /\[APPLAUSE\]/gi,
      "",
    )
    .replace(
      /\[LAUGHTER\]/gi,
      "",
    )
    .replace(
      /\[NOISE\]/gi,
      "",
    )
    .replace(
      /\[SILENCE\]/gi,
      "",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim()
}


// ============================================================
// Non speech
// ============================================================

function isNonSpeech(
  text: string,
): boolean {

  const value =
    text
      .trim()
      .toUpperCase()

  if (!value) {
    return true
  }

  const nonSpeech =
    new Set([
      "[BLANK_AUDIO]",
      "[GASP]",
      "[MUSIC]",
      "[APPLAUSE]",
      "[LAUGHTER]",
      "[NOISE]",
      "[SILENCE]",
      "(GASP)",
      "(MUSIC)",
      "(APPLAUSE)",
      "(LAUGHTER)",
    ])

  return nonSpeech.has(
    value,
  )
}

// ============================================================
// 纯语气词 / 哼唱检测
// ============================================================
//
// 只在【整块 Whisper 输出】只有语气词时丢弃。
// 例如：
//
//   "Hmm."     "Mmm"      "Um."
//   "嗯"       "啊——"     "La la la"
//
// 不会影响真实内容：
//
//   "好的，我们继续"   ← 不是纯语气词，正常通过
//   "好，那我们开始"   ← 同上
//
// 这和之前说的"不要写死过滤 好"不冲突：
// 这里过滤的是整块输出仅为发声（无语义）的情况。
// ============================================================

const FILLER_ONLY =
  /^(?:[hm]+|um+|uh+|ah+|oh+|er+|la(?:\s+la)+|啍+|嗯+|啊+|哦+|呃+|唔+|噢+|呀+|哎+|唉+|嗯?[。．.，,！!？?～~\s]*)$/i
// ============================================================
// Normalize
// ============================================================

function normalizeForCompare(
  text: string,
): string {

  return text
    .toLowerCase()
    .replace(
      /[“”"'‘’.,!?;:()[\]{}\-—…，。！？；：]/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim()
}


// ============================================================
// Word count
// ============================================================

function getWordCount(
  text: string,
): number {

  const value =
    text.trim()

  if (!value) {
    return 0
  }

  // 中文没有空格，所以按照中英文混合情况估算。
  const englishWords =
    value.match(
      /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g,
    ) || []

  const chineseChars =
    value.match(
      /[\u4e00-\u9fff]/g,
    ) || []

  return Math.max(
    englishWords.length,
    chineseChars.length,
  )
}


// ============================================================
// Strong sentence ending
// ============================================================

function hasSentenceEnding(
  text: string,
): boolean {

  return /[.!?。！？]["'”’)\]]*$/.test(
    text.trim(),
  )
}

// ============================================================
// 假句号修复
// ============================================================
//
// Whisper 输出的真正句子边界后面通常跟大写单词。
// 句号后面跟小写单词 → 大概率是碎片拼接造成的假边界。
//
// "show you. something interesting"
//                ↑ 小写 → 抹掉这个句号
//
// 中文没有大小写，不适用此规则（中文的。误断率本身低很多）。
// ============================================================

function relaxContinuationPeriods(
  text: string,
): string {

  return text.replace(
    /\. ([a-z])/g,
    " $1",
  )
}
// ============================================================
// Punctuation extraction
// ============================================================
//
// 例如：
//
// "Hello. How are you?"
//
// →
// "Hello."
// "How are you?"
//
// remainder = ""
//
// 小数点保护：
//
// 3.14
//
// 不会被切开。
// ============================================================

function extractCompletedSentences(
  text: string,
): {
  sentences: string[]
  remainder: string
} {

  const sentences:
    string[] =
    []

  let current =
    ""

  for (
    let i = 0;
    i < text.length;
    i++
  ) {

    const char =
      text[i]

    current +=
      char

    if (
      char === "." ||
      char === "!" ||
      char === "?" ||
      char === "。" ||
      char === "！" ||
      char === "？"
    ) {

      // 小数点
      if (
        char === "." &&
        i > 0 &&
        i + 1 < text.length &&
        /\d/.test(
          text[i - 1],
        ) &&
        /\d/.test(
          text[i + 1],
        )
      ) {

        continue
      }

      const sentence =
        current.trim()

      if (sentence) {

        sentences.push(
          sentence,
        )
      }

      current =
        ""
    }
  }

  return {
    sentences,
    remainder:
      current.trim(),
  }
}


// ============================================================
// Whisper merge
// ============================================================
//
// 例如：
//
// previous:
// "we are talking about"
//
// incoming:
// "about music."
//
// →
//
// "we are talking about music."
//
// 同时处理：
//
// previous:
// "I want"
//
// incoming:
// "I want to show you something"
//
// →
//
// "I want to show you something"
// ============================================================

function mergeWhisperText(
  previous: string,
  next: string,
): string {

  const a =
    cleanText(previous)

  const b =
    cleanText(next)

  if (!a) {
    return b
  }

  if (!b) {
    return a
  }


  const normalizedA =
    normalizeForCompare(a)

  const normalizedB =
    normalizeForCompare(b)


  // 完全相同
  if (
    normalizedA ===
    normalizedB
  ) {

    return a
  }


  // incoming 完全包含 previous
  if (
    normalizedB.includes(
      normalizedA,
    )
  ) {

    return b
  }


  // previous 完全包含 incoming
  if (
    normalizedA.includes(
      normalizedB,
    )
  ) {

    return a
  }


  const aWords =
    a.split(/\s+/)

  const bWords =
    b.split(/\s+/)


  const maxOverlap =
    Math.min(
      12,
      aWords.length,
      bWords.length,
    )


  for (
    let count = maxOverlap;
    count >= 1;
    count--
  ) {

    const aPart =
      normalizeForCompare(
        aWords
          .slice(
            aWords.length - count,
          )
          .join(" "),
      )

    const bPart =
      normalizeForCompare(
        bWords
          .slice(
            0,
            count,
          )
          .join(" "),
      )


    if (
      aPart &&
      aPart === bPart
    ) {

      const remainder =
        bWords
          .slice(count)
          .join(" ")

      if (!remainder) {
        return a
      }

      return cleanText(
        `${a} ${remainder}`,
      )
    }
  }


  return cleanText(
    `${a} ${b}`,
  )
}


// ============================================================
// 明显残句检测
// ============================================================
//
// 这是 V13 最重要的变化之一。
//
// Silence 不等于句子结束。
//
// 例如：
//
// "I want"
// "I think"
// "because"
// "we are going to"
//
// 如果这些后面暂时没有 Whisper，
// 不能立刻翻译。
//
// 注意：
// 这里只处理非常明显的情况。
// 不追求完整语法分析。
// ============================================================

function looksLikeIncompleteFragment(
  text: string,
): boolean {

  const value =
    cleanText(text)
      .toLowerCase()


  if (!value) {
    return true
  }


  const words =
    value.split(/\s+/)


  // ----------------------------------------------------------
  // 太短的英文片段
  // ----------------------------------------------------------

  if (
    words.length <
    MIN_WORDS_FOR_SILENCE_FLUSH
  ) {

    const shortFragmentPatterns = [

      /^i want$/,
      /^i need$/,
      /^i think$/,
      /^i feel$/,
      /^i guess$/,
      /^i hope$/,
      /^i know$/,
      /^i mean$/,

      /^we are$/,
      /^we're$/,
      /^we will$/,
      /^we'll$/,
      /^we can$/,
      /^we need$/,
      /^we want$/,
      /^we have$/,

      /^you can$/,
      /^you should$/,
      /^you need$/,

      /^it is$/,
      /^it's$/,
      /^there is$/,
      /^there are$/,

      /^because$/,
      /^although$/,
      /^if$/,
      /^when$/,
      /^while$/,

      /^and$/,
      /^but$/,
      /^or$/,
      /^so$/,
      /^then$/,

      /^to$/,
      /^for$/,
      /^with$/,
      /^from$/,
      /^about$/,
      /^the$/,
      /^a$/,
      /^an$/,
    ]


    if (
      shortFragmentPatterns.some(
        pattern =>
          pattern.test(value),
      )
    ) {

      return true
    }
  }


  // ----------------------------------------------------------
  // 明显以连接词/介词结尾
  // ----------------------------------------------------------

  const endingPatterns = [

    /\bi want$/,
    /\bi need$/,
    /\bi think$/,
    /\bi feel$/,
    /\bi guess$/,
    /\bi hope$/,
    /\bi know$/,

    /\bwe are$/,
    /\bwe're$/,
    /\bwe will$/,
    /\bwe'll$/,
    /\bwe can$/,
    /\bwe need$/,
    /\bwe want$/,

    /\byou can$/,
    /\byou should$/,
    /\byou need$/,

    /\bit is$/,
    /\bit's$/,
    /\bthere is$/,
    /\bthere are$/,

    /\bgoing to$/,
    /\btrying to$/,
    /\bwant to$/,
    /\bneed to$/,
    /\bplan to$/,

    /\bbecause$/,
    /\balthough$/,
    /\bif$/,
    /\bwhen$/,
    /\bwhile$/,

    /\band$/,
    /\bor$/,
    /\bbut$/,
    /\bso$/,
    /\bthen$/,

    /\bof$/,
    /\bfor$/,
    /\bwith$/,
    /\bfrom$/,
    /\babout$/,
    /\bto$/,
    /\bin$/,
    /\bon$/,
    /\bat$/,
  ]


  if (
    endingPatterns.some(
      pattern =>
        pattern.test(value),
    )
  ) {

    return true
  }


  // ----------------------------------------------------------
  // 中文明显残句
  // ----------------------------------------------------------

  const chineseEndingPatterns = [

    /我想$/,
    /我觉得$/,
    /我认为$/,
    /我们要$/,
    /我们想$/,
    /因为$/,
    /所以$/,
    /如果$/,
    /但是$/,
    /然后$/,
    /这个$/,
    /那个$/,
    /一个$/,
    /关于$/,
    /对于$/,
    /在$/,
    /和$/,
    /跟$/,
    /与$/,
    /把$/,
    /被$/,
  ]


  if (
    chineseEndingPatterns.some(
      pattern =>
        pattern.test(value),
    )
  ) {

    return true
  }


  return false
}


// ============================================================
// Clear silence timer
// ============================================================

function clearSilenceTimer() {

  if (
    silenceFlushTimer !== null
  ) {

    clearTimeout(
      silenceFlushTimer,
    )

    silenceFlushTimer =
      null
  }
}


// ============================================================
// Queue translation
// ============================================================

function queueTranslation(
  socket: WebSocket,
  text: string,
  reason: string,
) {

  const clean =
    cleanText(text)

  if (
    !clean
  ) {
    return
  }


  // ----------------------------------------------------------
  // Backlog protection: for live subtitles a translation that
  // arrives several sentences late is useless. If jobs already
  // piled up (Qwen slower than speech on this CPU), drop the
  // older ones and keep only the newest sentences.
  // ----------------------------------------------------------

  if (
    translationQueue.length >
    1
  ) {

    const dropped =
      translationQueue.splice(
        0,
        translationQueue.length -
          1,
      )

    console.log(
      `Dropped ${dropped.length} stale translation job(s) (translation backlog)`,
    )
  }


  const job:
    TranslationJob = {

    socket,

    text:
      clean,

    reason,

    generation:
      generationId,
  }


  translationQueue.push(
    job,
  )


  console.log(
    "Translation queued. Queue:",
    translationQueue.length,
  )


  processTranslationQueue()
}


// ============================================================
// Qwen translation
// ============================================================
// 检测文本语言（方向守卫用）
function detectTextLanguage(
  text: string,
): "zh" | "en" | "other" {
  if (
    /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u3040-\u30FF\u31F0-\u31FF]/.test(
      text,
    )
  ) {
    return "other"
  }
  if (/[\u4e00-\u9fff]/.test(text)) {
    return "zh"
  }
  if (/[a-zA-Z]{2,}/.test(text)) {
    return "en"
  }
  return "other"
}

async function translateWithQwen(
  text: string,
  language:
    | "auto"
    | "zh"
    | "en",
  forceTarget:
    | "zh"
    | "en"
    | null = null,
): Promise<string> {

  let instruction =
    ""

  if (forceTarget === "en") {

    // 方向守卫重试：中文输入 → 强制输出英文
    instruction = `
Translate the Chinese input into natural English.
The input may contain spoken fillers (嗯, 呃, 这个) — drop them in translation.
You MUST output English only. Outputting Chinese is FORBIDDEN.
If the input is not meaningful speech, output exactly: [NO_SPEECH]
Output ONLY the English translation, or ONLY [NO_SPEECH].
`

  } else if (forceTarget === "zh") {

    // 方向守卫重试：英文输入 → 强制输出中文
    instruction = `
Translate the English input into natural Simplified Chinese (简体中文).
Traditional Chinese characters are FORBIDDEN.
You MUST output Simplified Chinese only. Outputting English is FORBIDDEN.
If the input is not meaningful speech (humming, noise, interjections only),
output exactly: [NO_SPEECH]
Output ONLY the Simplified Chinese translation, or ONLY [NO_SPEECH].
`

  } else {

    // 常规路径：统一双向提示词（实测 v4 版）
    instruction = `
You are a live subtitle translator. The speaker only speaks Chinese or English.
The input is an automatic speech recognition result: it may contain recognition
errors, spoken fillers (嗯, 呃, 这个, you know, I mean), and may look
ungrammatical or garbled. That is normal — it is still real speech, and you
MUST translate it.

ABSOLUTE RULE: your output language is ALWAYS the opposite of the input language.
- English input (even broken or garbled English) → Chinese output.
- Chinese input (even with fillers or errors) → English output.
- Copying, correcting, or rewriting the input in its own language is FORBIDDEN.
- Drop meaningless fillers in the translation.
- Chinese output must always be Simplified Chinese (简体中文), never Traditional.

Example 1:
Input: and I want to show you something really interesting
Output: 我想给你看一些非常有意思的东西。

Example 2:
Input: 嗯这个的话我们今天就先到这里
Output: That's all for today.

Example 3:
Input: the conflict between opposites in the basis of or exit.
Output: 对立之间的冲突，是以此为基础还是退出。

Only output exactly [NO_SPEECH] if the input is clearly not real speech:
pure interjections with no content, a language other than Chinese/English,
or noise artifacts.

Output ONLY the translation, or ONLY [NO_SPEECH]. No other text.
`

  }


  console.log(
    "Qwen request started.",
  )


  const response =
    await fetch(
      QWEN_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({

            model:
              QWEN_MODEL,

            messages: [

              {
                role:
                  "system",

                content:
                  instruction.trim(),
              },

              {
                role:
                  "user",

                content:
                  text,
              },

            ],

            chat_template_kwargs: {
              enable_thinking:
                false,
            },

            temperature:
              0.15,

            max_tokens:
              120,

            stream:
              false,
          }),
      },
    )


  console.log(
    "Qwen HTTP status:",
    response.status,
  )


  if (
    !response.ok
  ) {

    throw new Error(
      `Qwen translation HTTP ${response.status}`,
    )
  }


  const data =
    await response.json()


  const result =
    data?.choices?.[0]?.message?.content


  if (
    typeof result !==
      "string" ||
    !result.trim()
  ) {

    throw new Error(
      "Qwen returned empty translation",
    )
  }


  return result.trim()
}


// ============================================================
// Process translation queue（并发版）
// ============================================================

function processTranslationQueue() {

  while (
    activeTranslations <
      MAX_PARALLEL_TRANSLATIONS &&
    translationQueue.length >
      0
  ) {

    const job =
      translationQueue.shift()


    if (!job) {

      continue
    }


    // ------------------------------------------------------
    // clear 后旧任务直接丢弃
    // ------------------------------------------------------

    if (
      job.generation !==
      generationId
    ) {

      console.log(
        "Skipping stale translation job.",
      )

      continue
    }


    activeTranslations++


    runTranslationJob(job)
      .catch(() => {})
      .finally(() => {

        activeTranslations--

        processTranslationQueue()
      })
  }
}


async function runTranslationJob(
  job: TranslationJob,
) {

  console.log("")

  console.log(
    "========================================",
  )

  console.log(
    `QWEN TRANSLATION (${job.reason})`,
  )

  console.log(
    "Original:",
  )

  console.log(
    job.text,
  )

  console.log(
    "========================================",
  )


  let translation =
    ""


  try {

    translation =
      await translateWithQwen(
        job.text,
        sourceLanguage,
      )


    // ----------------------------------------------------
    // 请求回来后再次检查 generation
    // ----------------------------------------------------

    if (
      job.generation !==
      generationId
    ) {

      console.log(
        "Translation finished after clear. Discarding.",
      )

      return
    }

  // Qwen 判定为非语音（哼唱/噪音/第三语言）→ 丢弃，不发字幕
    if (
      translation.includes("NO_SPEECH")
    ) {
      console.log(
        "Qwen flagged NO_SPEECH. Subtitle skipped.",
      )
      return
    }

    // ----------------------------------------------------
    // 方向守卫：输出语言必须与输入语言相反。
    // 复读、纠错（"修通顺"成同语言）、空输出 → 定向重试一次
    // ----------------------------------------------------
    const inputLang =
      detectTextLanguage(
        job.text,
      )

    if (
      inputLang === "zh" ||
      inputLang === "en"
    ) {
      const outLang =
        detectTextLanguage(
          translation,
        )

      if (
        outLang === inputLang ||
        outLang === "other"
      ) {

        // ------------------------------------------------
        // A guard retry doubles the Qwen load. When jobs are
        // already waiting, skip the subtitle instead — a late
        // retry makes the whole pipeline fall further behind.
        // ------------------------------------------------

        if (
          translationQueue.length >
          0
        ) {

          console.log(
            `Direction guard: ${inputLang} in → ${outLang} out. Queue busy, retry skipped.`,
          )

          return
        }

        console.log(
          `Direction guard: ${inputLang} in → ${outLang} out. Retrying...`,
        )

        translation =
          await translateWithQwen(
            job.text,
            sourceLanguage,
            inputLang === "zh"
              ? "en"
              : "zh",
          )

            if (
          translation.includes(
            "NO_SPEECH",
          )
        ) {
          console.log(
            "Retry flagged NO_SPEECH. Subtitle skipped.",
          )
          return
        }

        const retryLang =
          detectTextLanguage(
            translation,
          )

        if (
          retryLang === inputLang ||
          retryLang === "other"
        ) {
          console.log(
            "Direction guard failed twice. Subtitle skipped.",
          )
          return
        }
      }
    }

    console.log("")

    console.log(
      "========== QWEN TRANSLATION ==========",
    )

    console.log(
      translation,
    )

    console.log(
      "=======================================",
    )

  } catch (
    error
  ) {

    console.error(
      "Qwen translation failed:",
      error,
    )


    // ----------------------------------------------------
    // 翻译失败：
    // 不阻塞后面的字幕。
    // ----------------------------------------------------

    translation =
      job.text
  }


  if (
    job.generation !==
    generationId
  ) {

    return
  }


  if (
    job.socket.readyState !==
    WebSocket.OPEN
  ) {

    return
  }


  const targetLanguage =
    sourceLanguage === "en"
      ? "zh"
      : sourceLanguage === "zh"
        ? "en"
        : "auto"


  const subtitle = {

    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    timestamp:
      Date.now(),

    original:
      job.text,

    translation,

    sourceLanguage,

    targetLanguage,
  }


  const subtitlePayload =
    JSON.stringify({
      type:
        "subtitle",

      subtitle,
    })


  wss.clients.forEach(
    (client) => {
      if (
        client.readyState ===
        WebSocket.OPEN
      ) {
        client.send(
          subtitlePayload,
        )
      }
    },
  )


  console.log(
    "Subtitle sent. (broadcast)",
  )
}
// ============================================================
// Commit current buffer
// ============================================================

function commitCurrentSentence(
  reason: string,
) {

  const text =
    cleanText(
      sentenceBuffer,
    )


  const socket =
    sentenceSocket


  // ----------------------------------------------------------
  // 先清空 buffer。
  // ----------------------------------------------------------

  sentenceBuffer =
    ""

  sentenceSocket =
    null

  sentenceStartedAt =
    0

  lastWhisperReceivedAt =
    0

  clearSilenceTimer()


  if (
    !text ||
    !socket
  ) {

    return
  }


  console.log("")
  console.log(
    "========================================",
  )

  console.log(
    `COMPLETE SENTENCE (${reason})`,
  )

  console.log(
    text,
  )

  console.log(
    "========================================",
  )


  queueTranslation(
    socket,
    text,
    reason,
  )
}


// ============================================================
// Schedule silence flush
// ============================================================

function scheduleSilenceFlush() {

  clearSilenceTimer()


  if (
    !sentenceBuffer.trim()
  ) {

    return
  }


  const timerGeneration =
    generationId


  silenceFlushTimer =
    setTimeout(
      () => {

        silenceFlushTimer =
          null


        // ----------------------------------------------------
        // clear 后 timer 失效
        // ----------------------------------------------------

        if (
          timerGeneration !==
          generationId
        ) {

          return
        }


        if (
          !sentenceBuffer.trim()
        ) {

          return
        }


        const elapsed =
          Date.now() -
          lastWhisperReceivedAt


        // ----------------------------------------------------
        // 如果 timer 触发得太早，
        // 重新等待。
        // ----------------------------------------------------

        if (
          elapsed <
          SILENCE_FLUSH_MS
        ) {

          scheduleSilenceFlush()

          return
        }


        const current =
          cleanText(
            sentenceBuffer,
          )


        // ----------------------------------------------------
        // V13：
        // 明显残句不因为 silence 立即翻译。
        // ----------------------------------------------------

        if (
          looksLikeIncompleteFragment(
            current,
          )
        ) {

          console.log("")
          console.log(
            "========== SILENCE BUT INCOMPLETE ==========",
          )

          console.log(
            "No new Whisper text for:",
            elapsed,
            "ms",
          )

          console.log(
            "Keeping buffer:",
          )

          console.log(
            current,
          )

          console.log(
            "=============================================",
          )


          // 再等待一次。
          //
          // 这一次不使用 1000ms 的固定 timer，
          // 而是再给它一个完整窗口。
          silenceFlushTimer =
            setTimeout(
              () => {

                if (
                  timerGeneration !==
                  generationId
                ) {

                  return
                }


                if (
                  !sentenceBuffer.trim()
                ) {

                  return
                }


                const latest =
                  cleanText(
                    sentenceBuffer,
                  )


                // ------------------------------------------------
                // 第二次仍然是明显残句：
                //
                // 这时候不能无限等待。
                //
                // 例如：
                //
                // "I want"
                //
                // 用户真的说完了。
                //
                // 最终还是需要输出。
                // ------------------------------------------------

                console.log("")
                console.log(
                  "========== FINAL SILENCE FLUSH ==========",
                )

                console.log(
                  latest,
                )

                console.log(
                  "==========================================",
                )


                commitCurrentSentence(
                  "SILENCE_FINAL",
                )

              },
              SILENCE_FLUSH_MS,
            )


          return
        }


        console.log("")
        console.log(
          "========== SILENCE FLUSH ==========",
        )

        console.log(
          "No new Whisper text for:",
          elapsed,
          "ms.",
        )

        console.log(
          current,
        )

        console.log(
          "====================================",
        )


        commitCurrentSentence(
          "SILENCE",
        )

      },
      SILENCE_FLUSH_MS,
    )
}


// ============================================================
// Handle Whisper text
// ============================================================

async function handleWhisperText(
  socket: WebSocket,
  incomingText: string,
) {

  let clean =
    cleanText(
      incomingText,
    )

  // ==========================================================
  // 第三语言幻觉：谚文（韩文）/假名（日文）→ 必然是幻觉，整段丢弃
  // 中文汉字不在这些 Unicode 区间，正常中文不受影响
  // ==========================================================

  if (
    /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u3040-\u30FF\u31F0-\u31FF]/.test(
      clean,
    )
  ) {
    console.log(
      "Third-language hallucination dropped:",
      clean,
    )
    return
  }

  if (
    !clean ||
    isNonSpeech(
      incomingText,
    )
  ) {

    console.log(
      "Whisper blank / non-speech.",
    )

    return
  }


  const now =
    Date.now()

  if (
    FILLER_ONLY.test(clean)
  ) {

    console.log(
      "Whisper filler ignored:",
      clean,
    )

    return
  }
  // ==========================================================
  // Duplicate Whisper result
  // ==========================================================

  const normalized =
    normalizeForCompare(
      clean,
    )

  const normalizedLast =
    normalizeForCompare(
      lastWhisperText,
    )


  if (
    normalized &&
    normalized ===
      normalizedLast &&
    now -
      lastWhisperReceivedAt <
      WHISPER_DUPLICATE_WINDOW
  ) {

    console.log(
      "Whisper duplicate ignored:",
      clean,
    )

    return
  }


  lastWhisperText =
    clean


  lastWhisperReceivedAt =
    now


  console.log("")
  console.log(
    "========== NEW WHISPER TEXT ==========",
  )

  console.log(
    clean,
  )

  console.log(
    "=======================================",
  )


  // ==========================================================
  // 没有 buffer
  // ==========================================================

  if (
    !sentenceBuffer.trim()
  ) {

    sentenceBuffer =
      clean

    sentenceSocket =
      socket

    sentenceStartedAt =
      now

  } else {

    // ========================================================
    // 已经有 buffer
    // ========================================================

    sentenceBuffer =
      mergeWhisperText(
        sentenceBuffer,
        clean,
      )
  }


  console.log("")
  console.log(
    "========== SENTENCE BUFFER ==========",
  )

  console.log(
    sentenceBuffer,
  )

  console.log(
    "=====================================",
  )

// ==========================================================
  // 渐进入幕：中间结果立刻广播原文，
  // 翻译好的 subtitle 到达后自动替换
  // ==========================================================

  const interimPayload =
    JSON.stringify({
      type: "whisper",
      text: sentenceBuffer,
    })

  wss.clients.forEach(
    (client) => {
      if (
        client.readyState ===
          WebSocket.OPEN
      ) {
        client.send(
          interimPayload,
        )
      }
    },
  )
 // ==========================================================
  // 句号检测：完整句立即进翻译队列
  // ==========================================================

  sentenceBuffer =
    relaxContinuationPeriods(
      sentenceBuffer,
    )

  const extracted =
    extractCompletedSentences(
      sentenceBuffer,
    )


  if (
    extracted.sentences.length >
    0
  ) {

    const socketForSentence =
      sentenceSocket ||
      socket


    const sentences =
      extracted.sentences


    // --------------------------------------------------------
    // 尾句保护：
    //
    // buffer 末尾的最后一句话如果少于 3 个词，
    // 很可能只是 Whisper 碎片（"screen." / "you."），
    // 不单独提交，放回 buffer 等待和下一切片合并。
    //
    // 句子中间的句号是可信的，不受此限制。
    // --------------------------------------------------------

    let commitCount =
      sentences.length

    const last =
      sentences[
        sentences.length - 1
      ]

    if (
      getWordCount(last) <
      MIN_WORDS_FOR_SILENCE_FLUSH
    ) {

      commitCount =
        sentences.length - 1
    }


    for (
      let i = 0;
      i < commitCount;
      i++
    ) {

      console.log("")
      console.log(
        "========== PUNCTUATION COMMIT ==========",
      )

      console.log(
        sentences[i],
      )

      console.log(
        "=========================================",
      )


      queueTranslation(
        socketForSentence,
        sentences[i],
        "PUNCTUATION",
      )
    }


    // --------------------------------------------------------
    // buffer 更新为剩余部分
    // --------------------------------------------------------

    sentenceBuffer =
      commitCount ===
      sentences.length
        ? extracted.remainder
        : cleanText(
            `${last} ${
              extracted.remainder
            }`,
          )


    if (
      sentenceBuffer.trim()
    ) {

      sentenceSocket =
        socketForSentence

      if (
        !sentenceStartedAt
      ) {

        sentenceStartedAt =
          now
      }

      scheduleSilenceFlush()

    } else {

      sentenceBuffer =
        ""

      sentenceSocket =
        null

      sentenceStartedAt =
        0

      clearSilenceTimer()
    }


    return
  }

  scheduleSilenceFlush()
}


// ============================================================
// Audio queue processor
// ============================================================

// ------------------------------------------------------------
// 积压时最多把多少个切片合并成一次 Whisper 调用。
// 每个切片约 1.5s，4 个 = 6s 音频。
// ------------------------------------------------------------

const MAX_MERGED_CHUNKS = 4


// ------------------------------------------------------------
// 合并多个 WAV 切片。
//
// 浏览器端 float32ToWav 写的是固定 44 字节头 +
// 16-bit PCM 单声道，直接拼 PCM 数据再补一个头即可。
//
// 为什么要合并：每次调用 whisper-cli 都要
// 启动进程 + 从磁盘加载模型 + 跑 VAD，
// 这些固定开销按“次数”收费，不按“秒数”收费。
// CPU 慢的机器上，一次识别 6s 音频远快于四次识别 1.5s。
// ------------------------------------------------------------

function mergeWavBuffers(
  buffers: Buffer[],
): {
  wav: Buffer
  seconds: number
} | null {

  const parts:
    Buffer[] =
    []

  let totalBytes = 0


  for (
    const buffer of buffers
  ) {

    // 只信任自家编码器的格式；遇到意外格式放弃合并

    if (
      buffer.length <= 44 ||
      buffer
        .toString(
          "ascii",
          0,
          4,
        ) !== "RIFF"
    ) {

      return null
    }

    const pcm =
      buffer.subarray(
        44,
      )

    parts.push(
      pcm,
    )

    totalBytes +=
      pcm.length
  }


  if (
    totalBytes === 0
  ) {

    return null
  }


  const sampleRate =
    buffers[0].readUInt32LE(
      24,
    )


  const wav =
    Buffer.alloc(
      44 + totalBytes,
    )

  buffers[0].copy(
    wav,
    0,
    0,
    44,
  )

  wav.writeUInt32LE(
    36 + totalBytes,
    4,
  )

  wav.writeUInt32LE(
    totalBytes,
    40,
  )


  let offset = 44

  for (
    const part of parts
  ) {

    part.copy(
      wav,
      offset,
    )

    offset +=
      part.length
  }


  return {
    wav,
    seconds:
      totalBytes /
      2 /
      sampleRate,
  }
}


async function processAudioQueue() {

  if (
    processingAudio
  ) {

    return
  }


  processingAudio =
    true


  try {

    while (
      audioQueue.length >
      0
    ) {

      // ------------------------------------------------
      // Backlog handling: when transcription is slower
      // than real time, chunks pile up while Whisper is
      // busy. MERGE the pending chunks into ONE call —
      // same speech content, a fraction of the per-call
      // overhead (process spawn + model load + VAD).
      //
      // Anything older than the newest MAX_MERGED_CHUNKS
      // is stale — drop it so latency stays bounded.
      // ------------------------------------------------

      if (
        audioQueue.length >
        MAX_MERGED_CHUNKS
      ) {

        const dropped =
          audioQueue.splice(
            0,
            audioQueue.length -
              MAX_MERGED_CHUNKS,
          )

        console.log(
          "Dropped",
          dropped.length,
          "stale audio chunks (queue backlog)",
        )
      }


      const jobs =
        audioQueue.splice(
          0,
          audioQueue.length,
        )


      if (
        jobs.length ===
        0
      ) {
        continue
      }


      const socket =
        jobs[0].socket


      const merged =
        mergeWavBuffers(
          jobs.map(
            (job) => job.audio,
          ),
        )


      // Unexpected format -> fall back to the first chunk alone

      const wav =
        merged?.wav ??
        jobs[0].audio

      const audioSeconds =
        merged?.seconds ??
        (jobs[0].audio.length - 44) /
          2 /
          16000


      const filename =
        `./tmp-whisper-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.wav`


      try {

        console.log("")
        console.log(
          `Processing ${jobs.length} audio chunk(s), ${audioSeconds.toFixed(1)}s of audio, ${audioQueue.length} remaining`,
        )


        await writeFile(
          filename,
          wav,
        )


        console.log(
          "Audio saved:",
          filename,
        )


        console.log(
          "Starting Whisper...",
        )


        const whisperStartedAt =
          Date.now()

        const result =
          await transcribeAudio(
            filename,
            sourceLanguage,
          )

        const whisperElapsed =
          (Date.now() -
            whisperStartedAt) /
          1000

        console.log(
          `Whisper took ${whisperElapsed.toFixed(1)}s for ${audioSeconds.toFixed(1)}s of audio` +
            (whisperElapsed >
            audioSeconds
              ? " (SLOWER than real time — expect lag)"
              : ""),
        )


        console.log("")
        console.log(
          "========== WHISPER RESULT ==========",
        )

        console.log(
          result,
        )

        console.log(
          "====================================",
        )


        try {

          await unlink(
            filename,
          )

        } catch {
          // ignore
        }


        if (
          !result ||
          isNonSpeech(
            result,
          )
        ) {

          console.log(
            "Whisper blank / non-speech.",
          )

          continue
        }


        await handleWhisperText(
          socket,
          result,
        )

      } catch (
        error
      ) {

        console.error(
          "Whisper processing failed:",
          error,
        )


        try {

          await unlink(
            filename,
          )

        } catch {
          // ignore
        }
      }
    }

  } finally {

    processingAudio =
      false
  }
}


// ============================================================
// Clear all state
// ============================================================

function clearAllState() {

  console.log(
    "Clearing all subtitle state...",
  )


  // ----------------------------------------------------------
  // 让所有旧翻译请求失效
  // ----------------------------------------------------------

  generationId++


  // ----------------------------------------------------------
  // Audio
  // ----------------------------------------------------------

  audioQueue.length =
    0


  // ----------------------------------------------------------
  // Translation
  // ----------------------------------------------------------

  translationQueue.length =
    0


  // ----------------------------------------------------------
  // Sentence
  // ----------------------------------------------------------

  sentenceBuffer =
    ""

  sentenceSocket =
    null

  sentenceStartedAt =
    0

  lastWhisperReceivedAt =
    0

  lastWhisperText =
    ""


  clearSilenceTimer()


  console.log(
    "All subtitle state cleared.",
  )

  console.log(
    "Generation:",
    generationId,
  )
}


// ============================================================
// WebSocket connection
// ============================================================

wss.on(
  "connection",
  (
    socket,
    request,
  ) => {

    console.log(
      "Client connected:",
      request.socket.remoteAddress,
    )


    socket.on(
      "message",
      async (
        message,
        isBinary,
      ) => {

        // ====================================================
        // JSON
        // ====================================================

        if (
          !isBinary
        ) {

          const text =
            message.toString()


          console.log(
            "Received JSON:",
            text,
          )


          let data: any


          try {

            data =
              JSON.parse(
                text,
              )

          } catch {

            console.warn(
              "Received invalid JSON",
            )

            return
          }


          // ==================================================
          // Settings
          // ==================================================

          if (
            data?.type ===
            "settings"
          ) {

            if (
              data.sourceLanguage ===
                "auto" ||
              data.sourceLanguage ===
                "zh" ||
              data.sourceLanguage ===
                "en"
            ) {

              sourceLanguage =
                data.sourceLanguage


              console.log(
                "Source language changed:",
                sourceLanguage,
              )
            }


            return
          }


          // ==================================================
          // Clear
          // ==================================================

          if (
            data?.type ===
            "clear"
          ) {

            console.log(
              "Clear requested",
            )


            clearAllState()


            // ------------------------------------------------
            // 广播 clear
            // ------------------------------------------------

            wss.clients.forEach(
              (
                client,
              ) => {

                if (
                  client !==
                    socket &&
                  client.readyState ===
                    WebSocket.OPEN
                ) {

                  client.send(
                    JSON.stringify(
                      data,
                    ),
                  )
                }
              },
            )


            return
          }

        // ==================================================
          // Flush（停止录音时：提交当前句子，而不是丢弃）
          // ==================================================

          if (
            data?.type ===
            "flush"
          ) {

            console.log(
              "Flush requested",
            )


            if (
              sentenceBuffer.trim()
            ) {

              commitCurrentSentence(
                "STOP",
              )

            }

            return
          }
         
          // ==================================================
          // Other JSON
          // ==================================================

          wss.clients.forEach(
            (
              client,
            ) => {

              if (
                client !==
                  socket &&
                client.readyState ===
                  WebSocket.OPEN
              ) {

                client.send(
                  JSON.stringify(
                    data,
                  ),
                )
              }
            },
          )


          return
        }


        // ====================================================
        // Binary audio
        // ====================================================

        const audio =
          Buffer.from(
            message,
          )


        console.log(
          "Received binary audio:",
          audio.length,
          "bytes",
        )


        audioQueue.push({
          socket,
          audio,
        })


        console.log(
          "Audio queued. Queue length:",
          audioQueue.length,
        )


        processAudioQueue()
      },
    )


    // ========================================================
    // Socket close
    // ========================================================

    socket.on(
      "close",
      () => {

        console.log(
          "Client disconnected",
        )


        if (
          sentenceSocket ===
          socket
        ) {

          sentenceBuffer =
            ""

          sentenceSocket =
            null

          sentenceStartedAt =
            0

          lastWhisperReceivedAt =
            0

          lastWhisperText =
            ""

          clearSilenceTimer()
        }
      },
    )


    // ========================================================
    // Socket error
    // ========================================================

    socket.on(
      "error",
      (
        error,
      ) => {

        console.error(
          "Client socket error:",
          error,
        )
      },
    )
  },
)


// ============================================================
// Server error
// ============================================================

wss.on(
  "error",
  (
    error,
  ) => {

    console.error(
      "WebSocket server error:",
      error,
    )
  },
)
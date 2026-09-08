import { transcribeAudio } from "./whisperService"

const audioFile =
  "./whisper.cpp/samples/jfk.wav"

const result =
  await transcribeAudio(audioFile)

console.log("")
console.log("========== RESULT ==========")
console.log(result)
console.log("============================")

export class AudioRecorder {
  private audioContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null

  async start(
    onAudio: (audio: Float32Array) => void,
    deviceId?: string,
  ) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? {
            deviceId: {
              exact: deviceId,
            },
          }
        : true,
    })

    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & {
        webkitAudioContext: typeof AudioContext
      }).webkitAudioContext

    this.audioContext = new AudioContextClass({
      sampleRate: 16000,
    })

    this.source =
      this.audioContext.createMediaStreamSource(this.stream)

    this.processor =
      this.audioContext.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (event) => {
      const input =
        event.inputBuffer.getChannelData(0)

      onAudio(new Float32Array(input))
    }

    this.source.connect(this.processor)

    this.processor.connect(
      this.audioContext.destination,
    )
  }

  stop() {
    this.processor?.disconnect()
    this.source?.disconnect()

    this.stream?.getTracks().forEach((track) => {
      track.stop()
    })

    this.audioContext?.close()

    this.processor = null
    this.source = null
    this.stream = null
    this.audioContext = null
  }
}

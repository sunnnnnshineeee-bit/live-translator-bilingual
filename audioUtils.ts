export function float32ToWav(
  samples: Float32Array,
  sampleRate: number,
): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2)

  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write("WAVE", 8)

  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)

  buffer.write("data", 36)
  buffer.writeUInt32LE(samples.length * 2, 40)

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(
      -1,
      Math.min(1, samples[i]),
    )

    const value =
      sample < 0
        ? sample * 0x8000
        : sample * 0x7fff

    buffer.writeInt16LE(value, 44 + i * 2)
  }

  return buffer
}

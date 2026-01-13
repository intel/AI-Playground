/**
 * Audio utility functions for converting audio formats.
 * Implements WAV encoding based on the RIFF/WAV specification using DataView API.
 */

/**
 * Decodes an audio Blob into an AudioBuffer using the Web Audio API.
 */
async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioContext = new AudioContext()

  try {
    return await audioContext.decodeAudioData(arrayBuffer)
  } finally {
    await audioContext.close()
  }
}

/**
 * Writes interleaved PCM samples from an AudioBuffer to a DataView.
 * Samples are written as 16-bit signed integers (little-endian).
 */
function writePcmSamples(view: DataView, audioBuffer: AudioBuffer, offset: number): void {
  const numChannels = audioBuffer.numberOfChannels
  const numFrames = audioBuffer.length

  // Pre-fetch all channel data
  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch))
  }

  // Write interleaved samples
  let pos = offset
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Convert float [-1, 1] to 16-bit signed integer [-32768, 32767]
      const floatSample = channels[ch][frame]
      const intSample = Math.max(-32768, Math.min(32767, Math.floor(floatSample * 32768)))
      view.setInt16(pos, intSample, true) // little-endian
      pos += 2
    }
  }
}

/**
 * Converts an audio Blob (webm, mp3, etc.) to a WAV Blob.
 *
 * The output WAV file uses 16-bit PCM encoding with the same sample rate
 * and channel count as the input audio.
 *
 * @param audioBlob - The audio Blob to convert
 * @returns A Promise that resolves to a WAV Blob
 */
export async function convertToWav(audioBlob: Blob): Promise<Blob> {
  const audioBuffer = await decodeAudioBlob(audioBlob)

  const numChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const numFrames = audioBuffer.length
  const bytesPerSample = 2 // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numFrames * blockAlign

  // WAV file: 44-byte header + PCM data
  const wavBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(wavBuffer)

  // RIFF chunk descriptor
  view.setUint32(0, 0x52494646, false) // "RIFF" as big-endian (reads correctly as ASCII)
  view.setUint32(4, 36 + dataSize, true) // File size minus 8 bytes
  view.setUint32(8, 0x57415645, false) // "WAVE"

  // fmt sub-chunk
  view.setUint32(12, 0x666d7420, false) // "fmt "
  view.setUint32(16, 16, true) // Sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true) // Audio format (1 = PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true) // Bits per sample

  // data sub-chunk
  view.setUint32(36, 0x64617461, false) // "data"
  view.setUint32(40, dataSize, true)

  // Write PCM samples starting at byte 44
  writePcmSamples(view, audioBuffer, 44)

  return new Blob([wavBuffer], { type: 'audio/wav' })
}

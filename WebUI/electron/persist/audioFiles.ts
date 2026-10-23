import fs from 'node:fs'
import path from 'node:path'
import { getAudioDir } from './userDataPaths.ts'

/**
 * Writes a generated speech clip under the app's audio directory and returns
 * the path it landed on. Shared by the `saveGeneratedAudio` IPC (voice
 * previews, Home Agent replies) and the main-side `synthesizeTextToSpeech`
 * tool, so a clip is named the same way whoever produced it.
 */
export async function saveGeneratedAudioFile(
  audioBase64: string,
  filename: string,
  options?: { overwrite?: boolean },
): Promise<string> {
  const audioDir = getAudioDir()
  const safeName = path.basename(filename).replace(/[^\w.\-]+/g, '_')
  let outName = safeName.toLowerCase().endsWith('.wav') ? safeName : `${safeName}.wav`
  await fs.promises.mkdir(audioDir, { recursive: true })
  let filePath = path.join(audioDir, outName)
  // Chat audio keeps every take, so a name collision gets a `_1` suffix. A
  // caller that owns a single well-known file (a voice's preview) opts out:
  // suffixing would orphan the previous one on every re-save.
  if (fs.existsSync(filePath) && options?.overwrite !== true) {
    const ext = path.extname(outName)
    const base = outName.slice(0, outName.length - ext.length)
    let n = 1
    while (fs.existsSync(filePath)) {
      outName = `${base}_${n}${ext}`
      filePath = path.join(audioDir, outName)
      n++
    }
  }
  await fs.promises.writeFile(filePath, Buffer.from(audioBase64, 'base64'))
  return filePath
}

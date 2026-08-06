import { app } from 'electron'
import path from 'node:path'
import { packagedResourcesRoot } from './aipgRoot.ts'

export const externalResourcesDir = () =>
  path.resolve(app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../external/'))

export const getMediaDir = () => {
  let mediaDir: string
  if (process.env.USERPROFILE) {
    mediaDir = path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'media')
  } else if (process.env.HOME) {
    mediaDir = path.join(process.env.HOME, 'AI-Playground', 'media')
  } else {
    mediaDir = path.join(externalResourcesDir(), 'service', 'static', 'sd_out')
  }
  return mediaDir
}

/** Generated TTS and other agent audio (sibling to `media/`, which holds Comfy output and `input/`). */
export const getAudioDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'audio')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'audio')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'audio')
}

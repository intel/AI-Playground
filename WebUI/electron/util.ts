import { app } from 'electron'
import path from 'node:path'

export const getMediaDir = () => {
  const externalResourcesDir = path.resolve(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
  )
  let mediaDir: string
  if (process.env.USERPROFILE) {
    mediaDir = path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'media')
  } else if (process.env.HOME) {
    mediaDir = path.join(process.env.HOME, 'AI-Playground', 'media')
  } else {
    mediaDir = path.join(externalResourcesDir, 'service', 'static', 'sd_out')
  }
  return mediaDir
}

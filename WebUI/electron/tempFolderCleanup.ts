import fs from 'node:fs'
import path from 'node:path'

export function cleanupTempFolders(baseDir: string) {
  if (!fs.existsSync(baseDir)) return

  const tempFolderNames = ['_tmp']

  const entries = fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })
  const tempFolders = entries
    .filter((e) => e.isDirectory() && tempFolderNames.includes(e.name))
    .map((e) => path.join(baseDir, e.path))

  for (const tempFolder of tempFolders) {
    try {
      fs.rmSync(tempFolder, { recursive: true, force: true })
      console.log(`[cleanup] Removed temp folder: ${tempFolder}`)
    } catch (error) {
      console.error(`[cleanup] Failed to remove ${tempFolder}:`, error)
    }
  }

  if (tempFolders.length > 0) {
    console.log(`[cleanup] Cleaned up ${tempFolders.length} temp folder(s)`)
  }
}
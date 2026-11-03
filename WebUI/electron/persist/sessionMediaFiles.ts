import fs from 'node:fs/promises'
import path from 'node:path'

const GAME_MEDIA_DIR = 'generated'

/** A game folder's copy of a Session file, made on first need; its game-relative path. */
export async function ensureGameMediaCopy(source: string, gameDir: string): Promise<string | null> {
  const relative = path.posix.join(GAME_MEDIA_DIR, path.basename(source))
  const target = path.join(gameDir, GAME_MEDIA_DIR, path.basename(source))
  try {
    await fs.access(target)
    return relative
  } catch {
    // Not copied yet.
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target)
    return relative
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

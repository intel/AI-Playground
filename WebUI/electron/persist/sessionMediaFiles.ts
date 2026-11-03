import fs from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES_DIR, sessionFolderPaths } from './sessionFiles'

const GAME_MEDIA_DIR = 'generated'

/** `name`, or `name-1`, `name-2`, … — the first that is not taken in `dir`. */
export async function freeName(dir: string, name: string): Promise<string> {
  const { name: stem, ext } = path.parse(name)
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${ext}`
    try {
      await fs.access(path.join(dir, candidate))
    } catch {
      return candidate
    }
  }
}

/** Renames, copying only across volumes, where a rename cannot. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.copyFile(from, to)
    await fs.unlink(from)
  }
}

/** The Session's `files/` folder, created when missing. */
export async function ensureSessionFilesDir(sessionId: string): Promise<string> {
  const { filesDir } = sessionFolderPaths(sessionId)
  await fs.mkdir(filesDir, { recursive: true })
  return filesDir
}

/** Moves a regular file into the Session's `files/` under a free name; its Session-relative path. */
export async function moveIntoSessionFiles(
  sessionId: string,
  source: string,
): Promise<string | null> {
  if (!(await fs.stat(source)).isFile()) return null
  const filesDir = await ensureSessionFilesDir(sessionId)
  const name = await freeName(filesDir, path.basename(source))
  await moveFile(source, path.join(filesDir, name))
  return `${SESSION_FILES_DIR}/${name}`
}

/** Writes new bytes into the Session's `files/` under a free name; its Session-relative path. */
export async function writeNewSessionFile(
  sessionId: string,
  preferredName: string,
  bytes: Buffer,
): Promise<string> {
  const filesDir = await ensureSessionFilesDir(sessionId)
  const name = await freeName(filesDir, preferredName)
  await fs.writeFile(path.join(filesDir, name), bytes, { flag: 'wx' })
  return `${SESSION_FILES_DIR}/${name}`
}

/** Removes one regular file; a missing one is already removed. */
export async function removeRegularFile(file: string): Promise<void> {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error(`not a file: ${file}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await fs.rm(file)
}

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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const ACER_CAMERA_DIRECT_PROCESSES = [
  'AcerCameraDirectService.exe',
  'AcerCameraDirectW.exe',
  'AcerCameraDirectUserService.exe',
] as const

export function tasklistOutputIndicatesProcess(stdout: string, imageName: string): boolean {
  return stdout.toLowerCase().includes(imageName.toLowerCase())
}

async function runTasklistForImage(imageName: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'tasklist',
    ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
    { windowsHide: true, timeout: 8000 },
  )
  return stdout
}

export async function queryAcerCameraDirectRunning(
  platform: NodeJS.Platform,
  runTasklist: (imageName: string) => Promise<string> = runTasklistForImage,
): Promise<boolean> {
  if (platform !== 'win32') return false
  for (const imageName of ACER_CAMERA_DIRECT_PROCESSES) {
    try {
      const stdout = await runTasklist(imageName)
      if (tasklistOutputIndicatesProcess(stdout, imageName)) return true
    } catch {
      // try remaining process names
    }
  }
  return false
}

export function createCachedAcerCameraDirectProbe(
  query: () => Promise<boolean>,
  cacheMs = 2500,
): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | null = null
  let inFlight: Promise<boolean> | null = null
  return async () => {
    const now = Date.now()
    if (cached && now - cached.at < cacheMs) return cached.value
    if (inFlight) return inFlight
    const pending = query()
      .then((value) => {
        cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null
      })
    inFlight = pending
    return pending
  }
}

export const acerCameraDirectRunning = createCachedAcerCameraDirectProbe(() =>
  queryAcerCameraDirectRunning(process.platform),
)

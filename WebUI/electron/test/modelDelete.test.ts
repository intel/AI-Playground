import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
}))

const { PathsManager } = await import('../pathsManager')

// Deleting a model is permanent — there is no trash to fall back on — so this
// guard is the only thing between a bad path and unrelated user files. Every way
// out of the model directories gets its own case.

let root: string
let configPath: string
let ggufDir: string
let outsideDir: string
let manager: InstanceType<typeof PathsManager>

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-delete-')))
  configPath = path.join(root, 'model_config.json')
  ggufDir = path.join(root, 'models', 'ggufLLM')
  outsideDir = path.join(root, 'not-models')
  fs.mkdirSync(ggufDir, { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ggufLLM: ggufDir,
      openvinoLLM: path.join(root, 'models', 'openvino'),
      embedding: path.join(root, 'models', 'embedding'),
      faceswap: path.join(root, 'models', 'ComfyUI', 'insightface'),
      facerestore: path.join(root, 'models', 'ComfyUI', 'facerestore_models'),
    }),
  )
  manager = new PathsManager(configPath)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('PathsManager.resolveModelPath', () => {
  it('accepts a file inside a configured model directory', () => {
    const modelPath = path.join(ggufDir, 'org---repo', 'model.gguf')
    fs.mkdirSync(path.dirname(modelPath), { recursive: true })
    fs.writeFileSync(modelPath, 'weights')

    expect(manager.resolveModelPath(modelPath)).toEqual({ path: modelPath })
  })

  it('rejects a path outside every configured model directory', () => {
    const stray = path.join(outsideDir, 'important.txt')
    fs.writeFileSync(stray, 'do not delete me')

    const result = manager.resolveModelPath(stray)

    expect(result).toHaveProperty('error')
    expect(fs.existsSync(stray)).toBe(true)
  })

  it('rejects a traversal out of a model directory', () => {
    const stray = path.join(outsideDir, 'important.txt')
    fs.writeFileSync(stray, 'do not delete me')

    const result = manager.resolveModelPath(
      path.join(ggufDir, '..', '..', 'not-models', 'important.txt'),
    )

    expect(result).toHaveProperty('error')
  })

  it('rejects a symlink that points out of the model directories', () => {
    const target = path.join(outsideDir, 'secrets')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'key.txt'), 'secret')
    const link = path.join(ggufDir, 'escape')
    try {
      fs.symlinkSync(target, link, 'dir')
    } catch {
      // Windows without developer mode cannot create symlinks; the guard is
      // still exercised by the traversal case above.
      return
    }

    // The link sits inside the model directory, so only resolving it reveals the
    // escape — which is why the guard uses realpath rather than string prefixes.
    expect(manager.resolveModelPath(link)).toHaveProperty('error')
  })

  it('rejects the model directory itself, so one delete cannot wipe the library', () => {
    expect(manager.resolveModelPath(ggufDir)).toHaveProperty('error')
  })

  it('rejects a path that does not exist rather than reporting success', () => {
    expect(manager.resolveModelPath(path.join(ggufDir, 'ghost.gguf'))).toHaveProperty('error')
  })

  it('rejects an empty path', () => {
    expect(manager.resolveModelPath('')).toHaveProperty('error')
  })
})

describe('PathsManager.pruneEmptyModelDirs', () => {
  it('removes the repo directory a deleted model leaves empty', async () => {
    const repoDir = path.join(ggufDir, 'org---repo')
    const modelPath = path.join(repoDir, 'model.gguf')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(modelPath, 'weights')
    fs.rmSync(modelPath)

    await manager.pruneEmptyModelDirs(modelPath)

    expect(fs.existsSync(repoDir)).toBe(false)
  })

  it('keeps a repo directory that still holds another quantization', async () => {
    const repoDir = path.join(ggufDir, 'org---repo')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'kept-Q8.gguf'), 'weights')
    const removed = path.join(repoDir, 'gone-Q4.gguf')

    await manager.pruneEmptyModelDirs(removed)

    expect(fs.existsSync(repoDir)).toBe(true)
  })

  it('never removes the configured model directory itself', async () => {
    const modelPath = path.join(ggufDir, 'loose.gguf')
    fs.writeFileSync(modelPath, 'weights')
    fs.rmSync(modelPath)

    await manager.pruneEmptyModelDirs(modelPath)

    expect(fs.existsSync(ggufDir)).toBe(true)
  })

  it('does not walk outside the model directories', async () => {
    const stray = path.join(outsideDir, 'nested')
    fs.mkdirSync(stray)

    await manager.pruneEmptyModelDirs(path.join(stray, 'whatever'))

    expect(fs.existsSync(stray)).toBe(true)
    expect(fs.existsSync(outsideDir)).toBe(true)
  })
})

describe('PathsManager.mirroredModelPaths', () => {
  it('finds the ComfyUI copy of a faceswap model', () => {
    const storage = path.join(root, 'models', 'ComfyUI', 'insightface')
    fs.mkdirSync(storage, { recursive: true })
    const flatName = 'Aitrepreneur---insightface---inswapper_128.onnx'
    const stored = path.join(storage, flatName)
    fs.writeFileSync(stored, 'weights')

    const comfyRoot = path.join(root, 'ComfyUI', 'models')
    const mirrors = manager.mirroredModelPaths(stored, comfyRoot)

    // The downloader copies these into ComfyUI's own tree so the reactor node can
    // load them; deleting only the storage copy would leave the model working.
    expect(mirrors).toContain(path.join(comfyRoot, 'insightface', flatName))
  })

  it('returns nothing for a model with no ComfyUI mirror', () => {
    const modelPath = path.join(ggufDir, 'org---repo', 'model.gguf')
    fs.mkdirSync(path.dirname(modelPath), { recursive: true })
    fs.writeFileSync(modelPath, 'weights')

    expect(manager.mirroredModelPaths(modelPath, path.join(root, 'ComfyUI', 'models'))).toEqual([])
  })

  it('returns nothing when ComfyUI is not installed', () => {
    const storage = path.join(root, 'models', 'ComfyUI', 'insightface')
    fs.mkdirSync(storage, { recursive: true })
    const stored = path.join(storage, 'a---b---c.onnx')
    fs.writeFileSync(stored, 'weights')

    expect(manager.mirroredModelPaths(stored, undefined)).toEqual([])
  })
})

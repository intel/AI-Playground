import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// PathsManager resolves relative config paths against the app root, which needs
// electron's `app`. Only `isPackaged` matters here: false makes the base dir
// process.cwd(), and the test config writes absolute paths anyway.
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
}))

const { PathsManager } = await import('../pathsManager')

let root: string
let configPath: string

function writeConfig(paths: Record<string, string>) {
  fs.writeFileSync(configPath, JSON.stringify(paths))
}

/** A GGUF model as the downloader lays it out: `<owner>---<repo>/<file>.gguf`. */
function writeGguf(dir: string, repoDirName: string, fileName: string, bytes: number) {
  const repoDir = path.join(dir, repoDirName)
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(repoDir, fileName), Buffer.alloc(bytes))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-scan-'))
  configPath = path.join(root, 'model_config.json')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('PathsManager.scanModelLibrary', () => {
  it('reports GGUF files with a catalog-comparable name, size and path', () => {
    const ggufDir = path.join(root, 'ggufLLM')
    writeGguf(ggufDir, 'bartowski---Llama-3.2-3B-Instruct-GGUF', 'Llama-3.2-Q4_K_S.gguf', 2048)
    writeConfig({
      ggufLLM: ggufDir,
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
    })

    const scan = new PathsManager(configPath).scanModelLibrary()
    const model = scan.models.find((m) => m.pathKey === 'ggufLLM')

    expect(scan.failedPathKeys).toEqual([])
    expect(model).toBeDefined()
    // `---` stays in the raw name; matching to a catalog entry normalises both
    // sides (see normalizeModelKey), so the scan reports what is on disk.
    expect(model!.name).toBe('bartowski---Llama-3.2-3B-Instruct-GGUF/Llama-3.2-Q4_K_S.gguf')
    expect(model!.useCase).toBe('llm')
    expect(model!.serviceBackend).toBe('llama_cpp')
    expect(model!.sizeBytes).toBe(2048)
    expect(model!.isDirectory).toBe(false)
    expect(model!.modifiedAt).toBeGreaterThan(0)
    expect(fs.existsSync(model!.absolutePath)).toBe(true)
  })

  it('finds every quantization in a repo directory', () => {
    const ggufDir = path.join(root, 'ggufLLM')
    writeGguf(ggufDir, 'org---repo', 'model-Q4.gguf', 10)
    writeGguf(ggufDir, 'org---repo', 'model-Q8.gguf', 20)
    writeConfig({
      ggufLLM: ggufDir,
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
    })

    const names = new PathsManager(configPath)
      .scanModelLibrary()
      .models.filter((m) => m.pathKey === 'ggufLLM')
      .map((m) => m.name)
      .sort()

    expect(names).toEqual(['org---repo/model-Q4.gguf', 'org---repo/model-Q8.gguf'])
  })

  it('ignores non-GGUF files in the GGUF directory', () => {
    const ggufDir = path.join(root, 'ggufLLM', 'org---repo')
    fs.mkdirSync(ggufDir, { recursive: true })
    fs.writeFileSync(path.join(ggufDir, 'model.gguf'), 'x')
    fs.writeFileSync(path.join(ggufDir, 'README.md'), 'not a model')
    writeConfig({
      ggufLLM: path.join(root, 'ggufLLM'),
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
    })

    const names = new PathsManager(configPath).scanModelLibrary().models.map((m) => m.name)

    expect(names).toEqual(['org---repo/model.gguf'])
  })

  it('treats an OpenVINO model as one directory and sums its files', () => {
    const ovDir = path.join(root, 'ov', 'OpenVINO---Qwen3-8B-int4-ov')
    fs.mkdirSync(path.join(ovDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(ovDir, 'openvino_model.bin'), Buffer.alloc(500))
    fs.writeFileSync(path.join(ovDir, 'nested', 'extra.bin'), Buffer.alloc(300))
    writeConfig({
      ggufLLM: path.join(root, 'gguf'),
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
    })

    const model = new PathsManager(configPath)
      .scanModelLibrary()
      .models.find((m) => m.pathKey === 'openvinoLLM')

    expect(model!.name).toBe('OpenVINO---Qwen3-8B-int4-ov')
    expect(model!.isDirectory).toBe(true)
    // Recursive: an IR model is many files but one row in the UI.
    expect(model!.sizeBytes).toBe(800)
  })

  it('splits embedding models by their per-backend sub-directory', () => {
    const embDir = path.join(root, 'emb')
    fs.mkdirSync(path.join(embDir, 'llamaCPP', 'org---repo'), { recursive: true })
    fs.writeFileSync(path.join(embDir, 'llamaCPP', 'org---repo', 'bge.gguf'), 'x')
    fs.mkdirSync(path.join(embDir, 'openVINO', 'OpenVINO---bge-ov'), { recursive: true })
    fs.writeFileSync(path.join(embDir, 'openVINO', 'OpenVINO---bge-ov', 'model.bin'), 'y')
    writeConfig({
      ggufLLM: path.join(root, 'gguf'),
      openvinoLLM: path.join(root, 'ov'),
      embedding: embDir,
    })

    const embeddings = new PathsManager(configPath)
      .scanModelLibrary()
      .models.filter((m) => m.useCase === 'embedding')

    expect(embeddings).toHaveLength(2)
    expect(embeddings.find((m) => m.serviceBackend === 'llama_cpp')!.name).toBe(
      'org---repo/bge.gguf',
    )
    expect(embeddings.find((m) => m.serviceBackend === 'openvino')!.name).toBe('OpenVINO---bge-ov')
  })

  it('reports ComfyUI weights as media models', () => {
    const checkpoints = path.join(root, 'checkpoints')
    fs.mkdirSync(path.join(checkpoints, 'org---repo'), { recursive: true })
    fs.writeFileSync(path.join(checkpoints, 'org---repo', 'sd.safetensors'), Buffer.alloc(64))
    writeConfig({
      ggufLLM: path.join(root, 'gguf'),
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
      checkpoints,
    })

    const model = new PathsManager(configPath).scanModelLibrary().models[0]

    expect(model.useCase).toBe('media')
    expect(model.serviceBackend).toBe('comfyui')
    // Normalised to `/` so the same name is produced on Windows and Linux.
    expect(model.name).toBe('org---repo/sd.safetensors')
  })

  it('reports STT and TTS weights as speech models', () => {
    const ttsDir = path.join(root, 'TTS')
    fs.mkdirSync(path.join(ttsDir, 'tngtech---Kokoro-82M-int8-ov'), { recursive: true })
    fs.writeFileSync(path.join(ttsDir, 'tngtech---Kokoro-82M-int8-ov', 'model.bin'), 'x')
    writeConfig({
      ggufLLM: path.join(root, 'gguf'),
      openvinoLLM: path.join(root, 'ov'),
      embedding: path.join(root, 'emb'),
      TTS: ttsDir,
    })

    const model = new PathsManager(configPath).scanModelLibrary().models[0]

    expect(model.useCase).toBe('speech')
    expect(model.serviceBackend).toBe('openvino')
    expect(model.name).toBe('tngtech---Kokoro-82M-int8-ov')
  })

  it('skips path keys that are absent or unconfigured instead of failing', () => {
    writeConfig({
      ggufLLM: path.join(root, 'does-not-exist'),
      openvinoLLM: path.join(root, 'also-missing'),
      embedding: path.join(root, 'emb'),
    })

    const scan = new PathsManager(configPath).scanModelLibrary()

    expect(scan.models).toEqual([])
    expect(scan.failedPathKeys).toEqual([])
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DemoProfileSchema, loadDemoProfile } from '../demoProfile'

describe('DemoProfileSchema', () => {
  it('parses a fully-specified profile', () => {
    const input = {
      defaults: {
        chatPreset: 'Vision',
        chatModel: 'some/model.gguf',
        imageGenPreset: 'Pro Image',
        imageEditPreset: 'Edit by Prompt 2',
      },
      inputImage: 'dog.jpg',
      samplePrompts: [{ title: 'T', description: 'D', prompt: 'P', mode: 'chat' }],
      enabledModes: ['chat', 'imageGen'],
      notificationDotButtons: ['mode-button-chat'],
    }
    const result = DemoProfileSchema.parse(input)
    expect(result.defaults.chatPreset).toBe('Vision')
    expect(result.enabledModes).toEqual(['chat', 'imageGen'])
  })

  it('applies defaults for optional fields', () => {
    const input = {
      defaults: { chatPreset: 'A', chatModel: 'B' },
    }
    const result = DemoProfileSchema.parse(input)
    expect(result.inputImage).toBeNull()
    expect(result.samplePrompts).toEqual([])
    expect(result.enabledModes).toEqual(['chat', 'imageGen', 'imageEdit', 'video'])
    expect(result.notificationDotButtons).toEqual([])
  })

  it('rejects missing required fields', () => {
    expect(() => DemoProfileSchema.parse({})).toThrow()
    expect(() => DemoProfileSchema.parse({ defaults: {} })).toThrow()
  })

  it('rejects invalid mode values', () => {
    const input = {
      defaults: { chatPreset: 'A', chatModel: 'B' },
      enabledModes: ['chat', 'invalidMode'],
    }
    expect(() => DemoProfileSchema.parse(input)).toThrow()
  })
})

describe('loadDemoProfile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `demo-profile-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when _profile.json does not exist', () => {
    const logger = { warn: vi.fn() }
    const result = loadDemoProfile(tmpDir, logger)
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('parses a valid _profile.json without inputImage', () => {
    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      samplePrompts: [],
    }
    writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))
    const result = loadDemoProfile(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.defaults.chatPreset).toBe('X')
    expect(result!.inputImage).toBeNull()
  })

  it('resolves inputImage to a data URI', () => {
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(path.join(tmpDir, 'test.png'), pngBuffer)

    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      inputImage: 'test.png',
    }
    writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))

    const result = loadDemoProfile(tmpDir)
    expect(result!.inputImage).toMatch(/^data:image\/png;base64,/)
  })

  it('throws when inputImage references a missing file', () => {
    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      inputImage: 'nonexistent.jpg',
    }
    writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))
    expect(() => loadDemoProfile(tmpDir)).toThrow(/not found/)
  })

  it('throws on malformed JSON', () => {
    writeFileSync(path.join(tmpDir, '_profile.json'), '{bad json')
    expect(() => loadDemoProfile(tmpDir)).toThrow()
  })

  it('throws on schema validation failure', () => {
    writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify({ wrong: true }))
    expect(() => loadDemoProfile(tmpDir)).toThrow()
  })
})

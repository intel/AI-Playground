import { describe, expect, it } from 'vitest'
import { buildDummyGlb, devPresets } from '@/assets/js/store/devPresets'
import { PresetSchema } from '@/assets/js/store/presets'

const GLB_MAGIC = 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942

async function readGlb() {
  const buffer = await buildDummyGlb().arrayBuffer()
  const view = new DataView(buffer)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)),
  ) as Record<string, unknown>
  return {
    byteLength: buffer.byteLength,
    magic: new TextDecoder().decode(new Uint8Array(buffer, 0, 4)),
    version: view.getUint32(4, true),
    declaredLength: view.getUint32(8, true),
    jsonChunkType: view.getUint32(16, true),
    binChunkLength: view.getUint32(20 + jsonLength, true),
    binChunkType: view.getUint32(24 + jsonLength, true),
    json,
  }
}

describe('dummy workflow presets', () => {
  it('all satisfy the preset schema', () => {
    for (const preset of devPresets) {
      expect(() => PresetSchema.parse(preset), preset.name).not.toThrow()
    }
  })

  it('declare no requirements, so they never trigger an install or download', () => {
    for (const preset of devPresets) {
      expect(preset.requiredModels, preset.name).toEqual([])
      expect(preset.requiredCustomNodes, preset.name).toEqual([])
      expect(preset.requiredPythonPackages, preset.name).toEqual([])
    }
  })

  it('are exposed to the media tools and carry a media type', () => {
    for (const preset of devPresets) {
      expect(preset.toolCategory, preset.name).toBeDefined()
      expect(preset.mediaType, preset.name).toBeDefined()
    }
  })
})

describe('buildDummyGlb', () => {
  it('writes a structurally valid binary glTF', async () => {
    const glb = await readGlb()
    expect(glb.magic).toBe(GLB_MAGIC)
    expect(glb.version).toBe(2)
    expect(glb.declaredLength).toBe(glb.byteLength)
    expect(glb.jsonChunkType).toBe(GLB_CHUNK_JSON)
    expect(glb.binChunkType).toBe(GLB_CHUNK_BIN)
  })

  it('describes a single mesh whose accessors match the buffer', async () => {
    const { json, binChunkLength } = await readGlb()
    const accessors = json.accessors as Array<{ count: number; type: string }>
    const bufferViews = json.bufferViews as Array<{ byteOffset: number; byteLength: number }>
    expect((json.meshes as unknown[]).length).toBe(1)
    // 5 vertices (VEC3 floats) and 18 indices (scalar uint16) = 96 bytes.
    expect(accessors.map((a) => a.count)).toEqual([5, 18])
    expect(accessors[0].count * 12).toBe(bufferViews[0].byteLength)
    expect(accessors[1].count * 2).toBe(bufferViews[1].byteLength)
    expect(bufferViews[1].byteOffset).toBe(bufferViews[0].byteLength)
    expect(binChunkLength).toBeGreaterThanOrEqual(
      bufferViews[0].byteLength + bufferViews[1].byteLength,
    )
    expect(binChunkLength % 4).toBe(0)
  })
})

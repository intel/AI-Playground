import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUiPresetSchema } from '@/lib/presetSchemas'
import { requiredModelToComfyUIName } from '@/lib/comfyWorkflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetPath = path.resolve(__dirname, '../../../../modes/base/presets/pixel3d-trellis.json')
const modelConfigPath = path.resolve(__dirname, '../../../external/model_config.json')

const preset = ComfyUiPresetSchema.parse(JSON.parse(readFileSync(presetPath, 'utf-8')))
const modelPaths = JSON.parse(readFileSync(modelConfigPath, 'utf-8')) as Record<string, string>

describe('Pixel3D-Trellis preset', () => {
  it('applies the attention flag the shape sampler needs', () => {
    expect(preset.requiredComfyUiParameters).toEqual(['--use-quad-cross-attention'])
  })

  it('exposes only the final SaveGLB as an output node', () => {
    const outputs = Object.values(preset.comfyUiApiWorkflow).filter((node) =>
      ['SaveGLB', 'Save3DAdvanced', 'PreviewImage', 'Preview3DAdvanced', 'MaskPreview'].includes(
        node.class_type as string,
      ),
    )

    expect(outputs.map((node) => node.class_type as string)).toEqual(['SaveGLB'])
  })

  it('has a configured model directory for every required model type', () => {
    const missing = (preset.requiredModels ?? [])
      .map((model) => model.type)
      .filter((type) => !(type in modelPaths))

    expect(missing).toEqual([])
  })

  it('points every loader at the downloaded model path', () => {
    const loaderNames = new Set<string>(
      Object.values(preset.comfyUiApiWorkflow).flatMap((node) =>
        Object.entries(node.inputs ?? {})
          .filter(([name, value]) => name.endsWith('_name') && typeof value === 'string')
          .map(([, value]) => value as string),
      ),
    )

    for (const { model } of preset.requiredModels ?? []) {
      expect(loaderNames, model).toContain(requiredModelToComfyUIName(model))
    }
  })
})

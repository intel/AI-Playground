import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  buildPresetCatalog,
  loadPresetFiles,
  resolveComfyEntry,
  type PresetFile,
} from '../../artifact/catalog'
import { devPresets } from '@/lib/devPresetWorkflows'
import type { ComfyUiPreset } from '@/lib/presetSchemas'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** A schema-valid comfy template derived from a dev dummy. */
function comfyTemplate(overrides: Partial<ComfyUiPreset> = {}): ComfyUiPreset {
  return { ...clone(devPresets[0]), name: 'Test Image', ...overrides }
}

function fileFor(preset: unknown): PresetFile {
  return { content: JSON.stringify(preset), image: null }
}

describe('buildPresetCatalog', () => {
  const validComfy = comfyTemplate()
  const validChat = {
    type: 'chat',
    name: 'Test Chat',
    backends: ['llamaCPP'],
  }

  it('splits validated presets into comfy and chat maps by name', () => {
    const catalog = buildPresetCatalog([fileFor(validComfy), fileFor(validChat)])
    expect(catalog.comfy.get('Test Image')?.comfyUiApiWorkflow).toBeDefined()
    expect(catalog.chat.get('Test Chat')?.name).toBe('Test Chat')
  })

  it('skips files that do not parse as JSON', () => {
    const catalog = buildPresetCatalog([{ content: '{not json', image: null }, fileFor(validComfy)])
    expect(catalog.comfy.size).toBe(1)
  })

  it('skips presets that fail schema validation instead of throwing', () => {
    const broken = comfyTemplate({ comfyUiApiWorkflow: undefined })
    const catalog = buildPresetCatalog([fileFor(broken), fileFor(validComfy)])
    expect(catalog.comfy.size).toBe(1)
    expect(catalog.comfy.has('Test Image')).toBe(true)
  })

  it('injects dev presets only behind the flag', () => {
    const without = buildPresetCatalog([fileFor(validComfy)])
    const withDev = buildPresetCatalog([fileFor(validComfy)], { includeDevPresets: true })
    expect(without.comfy.has('Dummy Image (test)')).toBe(false)
    expect(withDev.comfy.has('Dummy Image (test)')).toBe(true)
    expect(withDev.comfy.get('Test Image')).toBeDefined()
  })
})

describe('resolveComfyEntry', () => {
  it('resolves by name and returns a clone the caller can mutate', () => {
    const preset = comfyTemplate()
    const catalog = buildPresetCatalog([fileFor(preset)])
    const entry = resolveComfyEntry(catalog, 'Test Image')
    expect(entry?.name).toBe('Test Image')
    entry!.comfyUiApiWorkflow['1']!.inputs!.color = 999
    expect(catalog.comfy.get('Test Image')!.comfyUiApiWorkflow['1']!.inputs!.color).not.toBe(999)
  })

  it('applies the requested variant over the base', () => {
    const preset = comfyTemplate({
      variants: [{ name: 'Fast', overrides: { settings: [{ label: 'Colour', defaultValue: 1 }] } }],
    })
    const catalog = buildPresetCatalog([fileFor(preset)])
    const entry = resolveComfyEntry(catalog, 'Test Image', 'Fast')
    const colour = entry!.settings.find((s) => s.label === 'Colour')
    expect(colour?.defaultValue).toBe(1)
  })

  it('falls back to the base on an unknown variant and to the first variant when none given', () => {
    const preset = comfyTemplate({
      variants: [
        { name: 'Fast', overrides: { settings: [{ label: 'Colour', defaultValue: 1 }] } },
        { name: 'Quality', overrides: { settings: [{ label: 'Colour', defaultValue: 2 }] } },
      ],
    })
    const catalog = buildPresetCatalog([fileFor(preset)])
    const colourOf = (entry: NonNullable<ReturnType<typeof resolveComfyEntry>>) =>
      entry.settings.find((s) => s.label === 'Colour')?.defaultValue
    expect(colourOf(resolveComfyEntry(catalog, 'Test Image', 'Nope')!)).toBe(2201331)
    expect(colourOf(resolveComfyEntry(catalog, 'Test Image')!)).toBe(1)
  })

  it('returns null for an unknown workflow name', () => {
    const catalog = buildPresetCatalog([fileFor(comfyTemplate())])
    expect(resolveComfyEntry(catalog, 'No such workflow')).toBeNull()
  })
})

describe('loadPresetFiles', () => {
  const dirs: string[] = []

  function makeDir(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `aipg-catalog-${name}-`))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('merges mode presets over base presets by name and applies the filters', async () => {
    const baseDir = makeDir('base')
    const modeDir = makeDir('mode')
    writeFileSync(
      path.join(baseDir, 'shared.json'),
      JSON.stringify(comfyTemplate({ name: 'Shared', backend: 'comfyui' })),
    )
    // excludePresets lists file basenames (as `disabledFeaturePresets` does),
    // not the preset names inside the files.
    writeFileSync(
      path.join(baseDir, 'extra.json'),
      JSON.stringify(comfyTemplate({ name: 'Excluded', backend: 'comfyui' })),
    )
    writeFileSync(
      path.join(baseDir, 'multi.json'),
      JSON.stringify(
        comfyTemplate({
          name: 'Multi',
          variants: [
            { name: 'Native', overrides: {} },
            { name: 'OVMS', backend: 'openvino', overrides: {} },
          ],
        }),
      ),
    )
    writeFileSync(
      path.join(modeDir, 'shared.json'),
      JSON.stringify(comfyTemplate({ name: 'Shared', description: 'mode override' })),
    )

    const files = await loadPresetFiles({
      baseDir,
      modeDir,
      imageFallbackDirs: [],
      excludePresets: ['extra'],
      excludeVariantBackends: ['openvino'],
    })
    const names = files.map((f) => JSON.parse(f.content).name).sort()
    expect(names).toEqual(['Multi', 'Shared'])
    expect(
      JSON.parse(files.find((f) => JSON.parse(f.content).name === 'Shared')!.content),
    ).toMatchObject({ description: 'mode override' })
    const multi = JSON.parse(files.find((f) => JSON.parse(f.content).name === 'Multi')!.content)
    expect(multi.variants.map((v: { name: string }) => v.name)).toEqual(['Native'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  availableBackends,
  availableDownloadStates,
  buildEntries,
  canonicalPathKey,
  countByUseCase,
  describeInferenceDefaults,
  entriesForProductMode,
  filterEntries,
  formatBytes,
  formatModifiedAt,
  matchesSearch,
  modelEntryId,
  modelLabel,
  normalizeModelKey,
  pathKeyForCatalogModel,
  readableModelName,
  sortEntries,
  useCaseLabel,
  type BuildEntriesInput,
} from './library'
import type { ModelEntry, ScannedModel } from './types'
import enUS from '../../i18n/en-US.json'
import italian from '../../i18n/it.json'

/** The real shipped strings, so a renamed key fails here rather than in the UI. */
const english = { tag: 'en-US', strings: enUS as Record<string, string> }

describe('normalizeModelKey', () => {
  it('reduces a catalog name and its on-disk form to the same key', () => {
    const catalog = 'bartowski/Llama-3.2-GGUF/Llama-3.2-Q4.gguf'
    const onDisk = 'bartowski---Llama-3.2-GGUF/Llama-3.2-Q4.gguf'
    expect(normalizeModelKey(onDisk)).toBe(normalizeModelKey(catalog))
  })

  it('handles the flat faceswap layout, where every separator became ---', () => {
    expect(normalizeModelKey('Aitrepreneur---insightface---inswapper_128.onnx')).toBe(
      normalizeModelKey('Aitrepreneur/insightface/inswapper_128.onnx'),
    )
  })

  it('normalises Windows separators so one file yields one key on either OS', () => {
    expect(normalizeModelKey('org---repo\\sub\\model.safetensors')).toBe(
      normalizeModelKey('org/repo/sub/model.safetensors'),
    )
  })

  it('is case-insensitive and collapses redundant separators', () => {
    expect(normalizeModelKey('Org//Repo/Model.GGUF')).toBe('org/repo/model.gguf')
  })
})

describe('modelEntryId', () => {
  it('separates identical names under different path keys', () => {
    expect(modelEntryId('lora', 'org/repo/x.safetensors')).not.toBe(
      modelEntryId('checkpoints', 'org/repo/x.safetensors'),
    )
  })
})

describe('modelLabel / readableModelName', () => {
  it('labels a model with its last path segment', () => {
    expect(modelLabel('org/repo/model-Q4.gguf')).toBe('model-Q4.gguf')
    expect(modelLabel('single')).toBe('single')
  })

  it('makes an on-disk name readable', () => {
    expect(readableModelName('org---repo\\sub\\model.bin')).toBe('org/repo/sub/model.bin')
  })
})

describe('canonicalPathKey', () => {
  it('collapses the historical aliases so a file is not listed twice', () => {
    expect(canonicalPathKey('loras')).toBe('lora')
    expect(canonicalPathKey('checkpoint')).toBe('checkpoints')
    expect(canonicalPathKey('vae')).toBe('vae')
  })
})

describe('pathKeyForCatalogModel', () => {
  it('maps chat model types to their directory', () => {
    expect(pathKeyForCatalogModel('llamaCPP', undefined)).toMatchObject({
      pathKey: 'ggufLLM',
      useCase: 'llm',
      serviceBackend: 'llama_cpp',
    })
    expect(pathKeyForCatalogModel('openVINO', undefined)).toMatchObject({
      pathKey: 'openvinoLLM',
      serviceBackend: 'openvino',
    })
  })

  it('needs a backend to place an embedding model', () => {
    expect(pathKeyForCatalogModel('embedding', 'llamaCPP')).toMatchObject({
      pathKey: 'embedding',
      useCase: 'embedding',
      serviceBackend: 'llama_cpp',
    })
    expect(pathKeyForCatalogModel('embedding', undefined)).toBeUndefined()
  })

  it('has no placement for remote or unclassified models', () => {
    expect(pathKeyForCatalogModel('cloud', undefined)).toBeUndefined()
    expect(pathKeyForCatalogModel('undefined', undefined)).toBeUndefined()
  })
})

describe('describeInferenceDefaults', () => {
  it('has nothing to say about a model with no recommendations', () => {
    expect(describeInferenceDefaults(undefined)).toBe('')
    expect(describeInferenceDefaults({})).toBe('')
  })

  it('names the base sampling with the wire names the model cards use', () => {
    expect(describeInferenceDefaults({ temperature: 0.6, topP: 0.95, topK: 20 })).toBe(
      'temperature 0.6, top_p 0.95, top_k 20',
    )
  })

  it('keeps the per-mode recommendations apart', () => {
    const described = describeInferenceDefaults({
      topK: 20,
      thinking: { temperature: 0.6 },
      instruct: { temperature: 0.7 },
      reasoningEffort: 'low',
    })

    expect(described).toBe(
      'top_k 20 · thinking: temperature 0.6 · instruct: temperature 0.7 · reasoning_effort low',
    )
  })
})

const scannedGguf: ScannedModel = {
  pathKey: 'ggufLLM',
  useCase: 'llm',
  serviceBackend: 'llama_cpp',
  name: 'org---repo/model.gguf',
  absolutePath: '/models/ggufLLM/org---repo/model.gguf',
  sizeBytes: 1024,
  modifiedAt: 1_700_000_000_000,
  isDirectory: false,
}

function input(overrides: Partial<BuildEntriesInput> = {}): BuildEntriesInput {
  return {
    catalogModels: [],
    scanned: [],
    requiredModels: [],
    speechModels: [],
    preferences: {},
    ...overrides,
  }
}

describe('buildEntries', () => {
  it('enriches a catalog model with the size and path found on disk', () => {
    const entries = buildEntries(
      input({
        catalogModels: [
          {
            name: 'org/repo/model.gguf',
            type: 'llamaCPP',
            downloaded: true,
            isPredefined: true,
            supportsVision: true,
          },
        ],
        scanned: [scannedGguf],
      }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'org/repo/model.gguf',
      label: 'model.gguf',
      useCase: 'llm',
      pathKey: 'ggufLLM',
      source: 'catalog',
      downloaded: true,
      absolutePath: scannedGguf.absolutePath,
      sizeBytes: 1024,
    })
    expect(entries[0].capabilities.supportsVision).toBe(true)
  })

  it('keeps a catalog model that is not on disk, with no path to act on', () => {
    const entries = buildEntries(
      input({
        catalogModels: [
          { name: 'org/repo/other.gguf', type: 'llamaCPP', downloaded: false, isPredefined: true },
        ],
      }),
    )

    expect(entries[0].downloaded).toBe(false)
    expect(entries[0].absolutePath).toBeUndefined()
  })

  it('marks a user-added model as custom so it can be removed from the list', () => {
    const entries = buildEntries(
      input({
        catalogModels: [
          {
            name: 'me/mine/model.gguf',
            type: 'llamaCPP',
            downloaded: false,
            isPredefined: false,
            isCustom: true,
          },
        ],
      }),
    )

    expect(entries[0].source).toBe('custom')
  })

  it('keeps a user-added model custom after it is downloaded', () => {
    // It used to become a plain disk find, which took "remove from list" away the
    // moment the download finished.
    const entries = buildEntries(
      input({
        catalogModels: [
          {
            name: 'org/repo/model.gguf',
            type: 'llamaCPP',
            downloaded: true,
            isPredefined: false,
            isCustom: true,
          },
        ],
        scanned: [scannedGguf],
      }),
    )

    expect(entries[0].source).toBe('custom')
    expect(entries[0].downloaded).toBe(true)
  })

  it('calls a model found only on disk a disk model', () => {
    const entries = buildEntries(
      input({
        catalogModels: [
          { name: 'org/repo/model.gguf', type: 'llamaCPP', downloaded: true, isPredefined: false },
        ],
        scanned: [scannedGguf],
      }),
    )

    expect(entries[0].source).toBe('disk')
  })

  it('carries the publisher settings through for the read-only display', () => {
    const entries = buildEntries(
      input({
        catalogModels: [
          {
            name: 'org/repo/model.gguf',
            type: 'llamaCPP',
            downloaded: false,
            isPredefined: true,
            inferenceDefaults: { temperature: 0.6, reasoningEffort: 'low' },
            llamaCppArgs: '--spec-type draft-mtp',
          },
        ],
      }),
    )

    expect(entries[0].inferenceDefaults).toMatchObject({ reasoningEffort: 'low' })
    expect(entries[0].llamaCppArgs).toBe('--spec-type draft-mtp')
  })

  it('skips cloud models, which have nothing local to manage', () => {
    const entries = buildEntries(
      input({
        catalogModels: [{ name: 'gpt-x', type: 'cloud', downloaded: true }],
      }),
    )

    expect(entries).toEqual([])
  })

  it('builds media rows from the presets plus the disk, matching them up', () => {
    const entries = buildEntries(
      input({
        scanned: [
          {
            pathKey: 'checkpoints',
            useCase: 'media',
            serviceBackend: 'comfyui',
            name: 'org---repo/sd.safetensors',
            absolutePath: '/models/ComfyUI/checkpoints/org---repo/sd.safetensors',
            sizeBytes: 2048,
            modifiedAt: 1,
            isDirectory: false,
          },
        ],
        requiredModels: [
          { presetName: 'Fast Image', type: 'checkpoints', model: 'org/repo/sd.safetensors' },
          { presetName: 'Quality Image', type: 'checkpoints', model: 'org/repo/sd.safetensors' },
          {
            presetName: 'Fast Image',
            type: 'vae',
            model: 'org/repo/vae.safetensors',
            additionalLicenceLink: 'https://example.invalid/licence',
          },
        ],
      }),
    )

    const onDisk = entries.find((e) => e.pathKey === 'checkpoints')!
    // The catalog name wins over the on-disk spelling, and both presets are credited.
    expect(onDisk.name).toBe('org/repo/sd.safetensors')
    expect(onDisk.downloaded).toBe(true)
    expect(onDisk.requiredBy).toEqual(['Fast Image', 'Quality Image'])

    const missing = entries.find((e) => e.pathKey === 'vae')!
    expect(missing.downloaded).toBe(false)
    expect(missing.useCase).toBe('media')
    expect(missing.additionalLicenseLink).toBe('https://example.invalid/licence')
  })

  it('lists one row per file even when a path key has an alias', () => {
    const entries = buildEntries(
      input({
        scanned: [
          {
            pathKey: 'lora',
            useCase: 'media',
            serviceBackend: 'comfyui',
            name: 'org---repo/style.safetensors',
            absolutePath: '/models/ComfyUI/loras/org---repo/style.safetensors',
            sizeBytes: 10,
            modifiedAt: 1,
            isDirectory: false,
          },
        ],
        requiredModels: [
          { presetName: 'Preset', type: 'loras', model: 'org/repo/style.safetensors' },
        ],
      }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].pathKey).toBe('lora')
    expect(entries[0].requiredBy).toEqual(['Preset'])
  })

  it('lists a speech model the app can load but has not downloaded', () => {
    const entries = buildEntries(
      input({
        speechModels: [
          {
            name: 'OpenVINO/whisper-base-int8-ov',
            pathKey: 'STT',
            usedBy: 'Speech To Text',
            serviceBackend: 'openvino',
          },
        ],
      }),
    )

    // Neither STT nor TTS has a model picker, so the library is the only place
    // these are visible before the feature downloads them on first use.
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'OpenVINO/whisper-base-int8-ov',
      useCase: 'speech',
      pathKey: 'STT',
      serviceBackend: 'openvino',
      source: 'catalog',
      downloaded: false,
      requiredBy: ['Speech To Text'],
    })
  })

  it('matches a downloaded speech model to its feature', () => {
    const entries = buildEntries(
      input({
        scanned: [
          {
            pathKey: 'TTS',
            useCase: 'speech',
            serviceBackend: 'openvino',
            name: 'tngtech---Kokoro-82M-int8-ov',
            absolutePath: '/models/TTS/tngtech---Kokoro-82M-int8-ov',
            sizeBytes: 4096,
            modifiedAt: 5,
            isDirectory: true,
          },
        ],
        speechModels: [
          {
            name: 'tngtech/Kokoro-82M-int8-ov',
            pathKey: 'TTS',
            usedBy: 'Text To Speech',
            serviceBackend: 'openvino',
          },
        ],
      }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      // The catalog spelling wins over the `---` form found on disk.
      name: 'tngtech/Kokoro-82M-int8-ov',
      downloaded: true,
      source: 'catalog',
      sizeBytes: 4096,
      requiredBy: ['Text To Speech'],
    })
  })

  it('keeps a downloaded sidecar model on its own backend, not the scanned directory tag', () => {
    // The STT/TTS scan targets tag the whole directory `openvino`, but the
    // standalone Whisper and Qwen3-TTS sidecars store their weights there too.
    // Taking the directory tag would mislabel them and `entriesForProductMode`
    // would then drop them on NVIDIA — so a downloaded model would never show up.
    const entries = buildEntries(
      input({
        scanned: [
          {
            pathKey: 'STT',
            useCase: 'speech',
            serviceBackend: 'openvino',
            name: 'openai---whisper-base',
            absolutePath: '/models/STT/openai---whisper-base',
            sizeBytes: 4096,
            modifiedAt: 5,
            isDirectory: true,
          },
        ],
        speechModels: [
          {
            name: 'openai/whisper-base',
            pathKey: 'STT',
            usedBy: 'Speech To Text (standalone Whisper base)',
            serviceBackend: 'whisper',
          },
        ],
      }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'openai/whisper-base',
      serviceBackend: 'whisper',
      downloaded: true,
      source: 'catalog',
    })
    expect(entriesForProductMode(entries, true)).toHaveLength(1)
  })

  it('keeps two speech models that share the TTS directory apart', () => {
    const entries = buildEntries(
      input({
        speechModels: [
          {
            name: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
            pathKey: 'TTS',
            usedBy: 'Text To Speech (Qwen3-TTS custom voice)',
            serviceBackend: 'qwen3_tts',
          },
          {
            name: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
            pathKey: 'TTS',
            usedBy: 'Text To Speech (Qwen3-TTS voice design)',
            serviceBackend: 'qwen3_tts',
          },
        ],
      }),
    )

    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('applies user preferences on top of the catalog', () => {
    const id = modelEntryId('ggufLLM', 'org/repo/model.gguf')
    const entries = buildEntries(
      input({
        catalogModels: [
          {
            name: 'org/repo/model.gguf',
            type: 'llamaCPP',
            downloaded: true,
            isPredefined: true,
            supportsToolCalling: false,
          },
        ],
        preferences: {
          [id]: { favorite: true, capabilities: { supportsToolCalling: true } },
        },
      }),
    )

    expect(entries[0].favorite).toBe(true)
    expect(entries[0].capabilities.supportsToolCalling).toBe(true)
    expect(entries[0].hasCapabilityOverrides).toBe(true)
  })
})

const entry = (overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'name'>): ModelEntry => ({
  label: modelLabel(overrides.name),
  useCase: 'llm',
  pathKey: 'ggufLLM',
  serviceBackend: 'llama_cpp',
  source: 'catalog',
  downloaded: true,
  capabilities: {},
  hasCapabilityOverrides: false,
  favorite: false,
  requiredBy: [],
  ...overrides,
})

describe('matchesSearch / filterEntries', () => {
  const entries = [
    entry({ id: '1', name: 'org/repo/Llama-3.2-Q4.gguf', capabilities: { supportsVision: true } }),
    entry({
      id: '2',
      name: 'org/repo/Qwen3-8B.gguf',
      capabilities: { supportsVision: true, supportsToolCalling: true },
    }),
    entry({ id: '3', name: 'org/repo/embedder.gguf', useCase: 'embedding' }),
    entry({
      id: '4',
      name: 'org/repo/sd.safetensors',
      useCase: 'media',
      serviceBackend: 'comfyui',
    }),
    entry({ id: '5', name: 'org/repo/pending.gguf', downloaded: false }),
  ]

  it('searches the visible label, case-insensitively', () => {
    expect(matchesSearch(entries[0], 'llama')).toBe(true)
    expect(matchesSearch(entries[0], 'ORG')).toBe(false)
    expect(matchesSearch(entries[0], '  ')).toBe(true)
  })

  it('lists every entry when no filter is set', () => {
    expect(filterEntries(entries, DEFAULT_FILTERS).map((e) => e.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
  })

  it('always keeps an explicitly protected row, even when filtered out', () => {
    const filters = { ...DEFAULT_FILTERS, useCase: 'media' as const }
    expect(filterEntries(entries, filters).map((e) => e.id)).not.toContain('3')

    const visible = filterEntries(entries, filters, { alwaysInclude: new Set(['3']) })
    expect(visible.map((e) => e.id)).toContain('3')
  })

  it('filters to the favorites, whatever their use case', () => {
    const withFavorites = [
      ...entries,
      entry({ id: '6', name: 'org/repo/loved.gguf', favorite: true }),
      entry({ id: '7', name: 'org/repo/loved.safetensors', useCase: 'media', favorite: true }),
    ]
    expect(
      filterEntries(withFavorites, { ...DEFAULT_FILTERS, useCase: 'favorites' }).map((e) => e.id),
    ).toEqual(['6', '7'])
  })

  it('filters by use case, backend and download state', () => {
    expect(
      filterEntries(entries, { ...DEFAULT_FILTERS, useCase: 'media' }).map((e) => e.id),
    ).toEqual(['4'])
    expect(
      filterEntries(entries, { ...DEFAULT_FILTERS, backend: 'comfyui' }).map((e) => e.id),
    ).toEqual(['4'])
    expect(
      filterEntries(entries, { ...DEFAULT_FILTERS, downloadState: 'notDownloaded' }).map(
        (e) => e.id,
      ),
    ).toEqual(['5'])
  })

  it('ANDs the capability filters and ignores the deselected ones', () => {
    expect(
      filterEntries(entries, { ...DEFAULT_FILTERS, capabilities: ['vision'] }).map((e) => e.id),
    ).toEqual(['1', '2'])
    expect(
      filterEntries(entries, { ...DEFAULT_FILTERS, capabilities: ['vision', 'tools'] }).map(
        (e) => e.id,
      ),
    ).toEqual(['2'])
  })
})

describe('sortEntries', () => {
  it('pins favorites above everything else', () => {
    const entries = [
      entry({ id: '1', name: 'a/b/aaa.gguf' }),
      entry({ id: '2', name: 'a/b/zzz.gguf', favorite: true }),
    ]
    expect(sortEntries(entries, DEFAULT_SORT).map((e) => e.id)).toEqual(['2', '1'])
  })

  it('puts models on disk before ones that still need downloading', () => {
    const entries = [
      entry({ id: '1', name: 'a/b/aaa.gguf', downloaded: false }),
      entry({ id: '2', name: 'a/b/zzz.gguf', downloaded: true }),
    ]
    expect(sortEntries(entries, DEFAULT_SORT).map((e) => e.id)).toEqual(['2', '1'])
  })

  it('sorts by size in both directions, treating unknown as smallest', () => {
    const entries = [
      entry({ id: 'small', name: 'a/b/s.gguf', sizeBytes: 10 }),
      entry({ id: 'big', name: 'a/b/b.gguf', sizeBytes: 100 }),
      entry({ id: 'unknown', name: 'a/b/u.gguf' }),
    ]
    expect(sortEntries(entries, { key: 'size', direction: 'asc' }).map((e) => e.id)).toEqual([
      'unknown',
      'small',
      'big',
    ])
    expect(sortEntries(entries, { key: 'size', direction: 'desc' }).map((e) => e.id)).toEqual([
      'big',
      'small',
      'unknown',
    ])
  })

  it('does not mutate the input', () => {
    const entries = [entry({ id: '1', name: 'a/b/z.gguf' }), entry({ id: '2', name: 'a/b/a.gguf' })]
    sortEntries(entries, DEFAULT_SORT)
    expect(entries.map((e) => e.id)).toEqual(['1', '2'])
  })
})

describe('entriesForProductMode', () => {
  const mixed = [
    entry({ id: '1', name: 'a/b/c.gguf' }),
    entry({ id: '2', name: 'a/b/d', serviceBackend: 'openvino' }),
    entry({ id: '3', name: 'a/b/e.safetensors', useCase: 'media', serviceBackend: 'comfyui' }),
    entry({ id: '4', name: 'Qwen/Qwen3-TTS', useCase: 'speech', serviceBackend: 'qwen3_tts' }),
  ]

  it('leaves everything alone outside NVIDIA mode', () => {
    expect(entriesForProductMode(mixed, false)).toEqual(mixed)
  })

  it('drops OpenVINO models on NVIDIA, keeping the CUDA sidecar ones', () => {
    // Qwen3-TTS weights sit in the OpenVINO directories but run on their own
    // backend, so they must survive a filter aimed at the OpenVINO service.
    expect(entriesForProductMode(mixed, true).map((e) => e.id)).toEqual(['1', '3', '4'])
  })
})

describe('availableBackends / availableDownloadStates', () => {
  it('lists only the backends and states some entry is actually in', () => {
    const someEntries = [
      entry({ id: '1', name: 'a/b/c.gguf' }),
      entry({ id: '2', name: 'a/b/d.gguf', downloaded: false }),
      entry({ id: '3', name: 'a/b/e.safetensors', useCase: 'media', serviceBackend: 'comfyui' }),
    ]
    expect(availableBackends(someEntries)).toEqual(['llama_cpp', 'comfyui'])
    expect(availableDownloadStates(someEntries)).toEqual(['downloaded', 'notDownloaded'])
  })

  it('collapses to a single option when the entries agree', () => {
    // This is what locks the toolbar dropdown: one option means no choice to make.
    const openvinoOnly = [
      entry({ id: '1', name: 'a/b/c', serviceBackend: 'openvino' }),
      entry({ id: '2', name: 'a/b/d', serviceBackend: 'openvino' }),
    ]
    expect(availableBackends(openvinoOnly)).toEqual(['openvino'])
    expect(availableDownloadStates(openvinoOnly)).toEqual(['downloaded'])
  })

  it('offers nothing for an empty category', () => {
    expect(availableBackends([])).toEqual([])
    expect(availableDownloadStates([])).toEqual([])
  })
})

describe('countByUseCase', () => {
  it('counts each use case, the favorites and the total', () => {
    const counts = countByUseCase([
      entry({ id: '1', name: 'a/b/c.gguf', favorite: true }),
      entry({ id: '2', name: 'a/b/d.gguf', useCase: 'embedding' }),
      entry({ id: '3', name: 'a/b/e.safetensors', useCase: 'media', favorite: true }),
    ])
    // Favorites cut across the use cases, so they are counted on top, not instead.
    expect(counts).toEqual({ all: 3, favorites: 2, llm: 1, embedding: 1, media: 1, speech: 0 })
  })
})

describe('formatBytes / formatModifiedAt', () => {
  it('formats sizes at a useful precision', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
    expect(formatBytes(20 * 1024 ** 3)).toBe('20 GB')
  })

  it('formats recency in the coarsest useful unit', () => {
    const now = Date.UTC(2026, 0, 10)
    expect(formatModifiedAt(undefined, english, now)).toBe('—')
    expect(formatModifiedAt(now - 5_000, english, now)).toBe('just now')
    expect(formatModifiedAt(now - 5 * 60_000, english, now)).toBe('5m ago')
    expect(formatModifiedAt(now - 3 * 3_600_000, english, now)).toBe('3h ago')
    expect(formatModifiedAt(now - 2 * 86_400_000, english, now)).toBe('2d ago')
    // Beyond a month a relative age stops being informative.
    expect(formatModifiedAt(now - 400 * 86_400_000, english, now)).toMatch(/\d/)
  })

  it('takes every word it prints from the locale', () => {
    const now = Date.UTC(2026, 0, 10)
    // A locale that words the same units differently must change the output —
    // otherwise something is still hard-coded in English.
    const italian = {
      tag: 'it',
      strings: {
        MODEL_MANAGER_TIME_JUST_NOW: 'adesso',
        MODEL_MANAGER_TIME_MINUTES: '{count} min fa',
        MODEL_MANAGER_TIME_HOURS: '{count} h fa',
        MODEL_MANAGER_TIME_DAYS: '{count} g fa',
      },
    }
    expect(formatModifiedAt(now - 5_000, italian, now)).toBe('adesso')
    expect(formatModifiedAt(now - 5 * 60_000, italian, now)).toBe('5 min fa')
    expect(formatModifiedAt(now - 3 * 3_600_000, italian, now)).toBe('3 h fa')
    expect(formatModifiedAt(now - 2 * 86_400_000, italian, now)).toBe('2 g fa')
    // The date fallback follows the app's language, not the machine's: 4 March
    // renders day-first in Italian and month-first in US English.
    const old = Date.UTC(2024, 2, 4)
    expect(formatModifiedAt(old, italian, now)).not.toBe(formatModifiedAt(old, english, now))
  })

  it('labels use cases from the locale', () => {
    expect(useCaseLabel('media', english)).toBe('Media creation')
    expect(useCaseLabel('speech', { tag: 'it', strings: { ...enUS, ...italian } })).toBe('Voce')
  })
})

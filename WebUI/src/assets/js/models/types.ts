// Unified model model. The app knows about models from three unrelated places —
// the LLM/embedding catalog in `store/models.ts`, ComfyUI media weights derived
// from preset `requiredModels`, and hard-coded speech repos — and nothing could
// render them as one list. `ModelEntry` is that one row shape, so the model
// management view and the pure helpers in `library.ts` never care which catalog
// a model came from.
//
// Imported by the Electron main process too (`electron/pathsManager.ts` uses
// MODEL_SCAN_TARGETS), so this file must stay free of Vue/Pinia imports.
import type { InferenceDefaults } from '@/types/shared'

/** What the model is for. Drives the use-case filter in the management view. */
export type ModelUseCase = 'llm' | 'embedding' | 'media' | 'speech'

/**
 * Which service consumes the weights. Doubles as the download API's `backend`,
 * except for the sidecars (`qwen3_tts`, `whisper`) whose weights live in the
 * OpenVINO-owned model tree — see `downloadParams.downloadBackendOf`.
 */
export type ModelServiceBackend = 'llama_cpp' | 'openvino' | 'comfyui' | 'qwen3_tts' | 'whisper'

/**
 * Where the app learned about this model:
 * - `catalog` — listed in `models.json` or a preset's `requiredModels`
 * - `disk` — only found by scanning a model directory
 * - `custom` — added by the user via the Add Model dialog
 */
export type ModelSource = 'catalog' | 'disk' | 'custom'

/**
 * The optional capability/metadata fields a model can carry. Shared with `Model`
 * in `store/models.ts` and overridable per model via `store/modelPreferences.ts`.
 */
export type ModelCapabilityValues = {
  /** Companion multimodal projector repo (llama.cpp vision models). */
  mmproj?: string
  supportsToolCalling?: boolean
  /** OVMS `--tool_parser` override; defaults to 'hermes3'. */
  toolParser?: string
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  npuSupport?: boolean
  /**
   * Good enough at writing code to drive a coding preset (Game Agent). A
   * judgement about the model's training rather than a hard capability, but
   * overridable all the same: without it a user-added model can never be picked
   * for a coding preset.
   */
  supportsCoding?: boolean
  /**
   * Large Mixture-of-Experts model. NOT a plain capability: it is a hardware
   * gate. Such models only load via Phison aiDAPTIV+ SSD offload, so pickers
   * hide them when no Phison SSD is detected.
   */
  largeMoe?: boolean
}

/**
 * Every capability field, so merging layers can pick exactly these and never leak
 * neighbouring properties (a `Model` also carries `name`, `downloaded`, …).
 */
export const CAPABILITY_KEYS = [
  'mmproj',
  'supportsToolCalling',
  'toolParser',
  'supportsVision',
  'supportsReasoning',
  'supportsThinkingToggle',
  'maxContextSize',
  'npuSupport',
  'supportsCoding',
  'largeMoe',
] as const satisfies readonly (keyof ModelCapabilityValues)[]

/** Capability keys the edit dialog exposes as checkboxes, in display order. */
export const EDITABLE_CAPABILITY_KEYS = [
  'supportsVision',
  'supportsToolCalling',
  'supportsReasoning',
  'supportsThinkingToggle',
  'supportsCoding',
  'npuSupport',
  'largeMoe',
] as const satisfies readonly (keyof ModelCapabilityValues)[]

export type EditableCapabilityKey = (typeof EDITABLE_CAPABILITY_KEYS)[number]

/** One row in the model management view. */
export type ModelEntry = {
  /** Stable identity `${pathKey}:${normalizeModelKey(name)}` — the same file name can exist under two path keys. */
  id: string
  /** Catalog-form name, e.g. `bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q4_K_S.gguf`. */
  name: string
  /** Last path segment — what the pickers already show. */
  label: string
  useCase: ModelUseCase
  /** `model_config.json` key. Doubles as the download API's `type`. */
  pathKey: string
  serviceBackend: ModelServiceBackend
  source: ModelSource
  downloaded: boolean
  /** Only set when found on disk. Never reconstructed in the renderer — see scanModelLibrary. */
  absolutePath?: string
  sizeBytes?: number
  modifiedAt?: number
  isDirectory?: boolean
  /** Effective values after user overrides. Only meaningful for `llm`. */
  capabilities: ModelCapabilityValues
  /**
   * Sampling the model's publisher recommends. Catalog-owned, so the management
   * view shows it read-only: it explains behaviour the user cannot otherwise see.
   */
  inferenceDefaults?: InferenceDefaults
  /** Extra `llama-server` flags the catalog asks for. Read-only, as above. */
  llamaCppArgs?: string
  /** True when the user has edited any capability, so the UI can offer "reset to defaults". */
  hasCapabilityOverrides: boolean
  favorite: boolean
  /**
   * What needs this model: preset names for media models, feature names for
   * speech models. Drives the "used by" column and the delete warning.
   */
  requiredBy: string[]
  /** Extra licence the user must acknowledge before downloading (media models). */
  additionalLicenseLink?: string
}

/**
 * A directory to scan for models. `pathKey` selects the directory from
 * `model_config.json`; `subDir` handles embedding models, which live in a
 * per-backend sub-directory of one shared path key.
 */
export type ModelScanTarget = {
  pathKey: string
  subDir?: string
  useCase: ModelUseCase
  serviceBackend: ModelServiceBackend
  /** Whether one model is a single file or a whole directory on disk. */
  entryKind: 'file' | 'directory'
  /** When set, only files with this extension count as a model. */
  extension?: string
}

/**
 * Every model directory the app can scan, with how models are laid out in it.
 * Mirrors `external/model_config.json`; path keys absent from a user's config
 * are skipped at scan time rather than failing.
 */
export const MODEL_SCAN_TARGETS: readonly ModelScanTarget[] = [
  {
    pathKey: 'ggufLLM',
    useCase: 'llm',
    serviceBackend: 'llama_cpp',
    entryKind: 'file',
    extension: '.gguf',
  },
  { pathKey: 'openvinoLLM', useCase: 'llm', serviceBackend: 'openvino', entryKind: 'directory' },
  {
    pathKey: 'embedding',
    subDir: 'llamaCPP',
    useCase: 'embedding',
    serviceBackend: 'llama_cpp',
    entryKind: 'file',
    extension: '.gguf',
  },
  {
    pathKey: 'embedding',
    subDir: 'openVINO',
    useCase: 'embedding',
    serviceBackend: 'openvino',
    entryKind: 'directory',
  },
  { pathKey: 'checkpoints', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'inpaint', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'unet', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'diffusion_models', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'clip', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'vae', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'lora', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'controlNet', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'upscale', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'faceswap', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'facerestore', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  { pathKey: 'nsfwdetector', useCase: 'media', serviceBackend: 'comfyui', entryKind: 'file' },
  {
    pathKey: 'openvino-image',
    useCase: 'media',
    serviceBackend: 'openvino',
    entryKind: 'directory',
  },
  { pathKey: 'STT', useCase: 'speech', serviceBackend: 'openvino', entryKind: 'directory' },
  { pathKey: 'TTS', useCase: 'speech', serviceBackend: 'openvino', entryKind: 'directory' },
]

/**
 * `faceswap` / `facerestore` weights are copied from their storage directory
 * into ComfyUI's own model tree so the reactor node can load them (see
 * `service/utils.py: copy_faceswap_facerestore_to_comfyui`). Deleting the
 * storage copy alone would leave the model working, so the mirror must go too.
 */
export const COMFYUI_MIRRORED_PATH_KEYS: Readonly<Record<string, string>> = {
  faceswap: 'insightface',
  facerestore: 'facerestore_models',
}

/** One model directory as resolved and scanned by the main process. */
export type ScannedModel = {
  pathKey: string
  useCase: ModelUseCase
  serviceBackend: ModelServiceBackend
  /** Readable name: `---` and OS separators normalised to `/`. */
  name: string
  absolutePath: string
  sizeBytes: number
  /** Newest mtime within the model (max over children for directory models). */
  modifiedAt: number
  isDirectory: boolean
}

export type ModelLibraryScan = {
  models: ScannedModel[]
  /** Path keys whose scan failed, so the UI can report without blanking the table. */
  failedPathKeys: string[]
}

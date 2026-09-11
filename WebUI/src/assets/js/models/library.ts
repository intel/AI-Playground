// Pure derivation, filtering and sorting for the model library. No Pinia, no
// Vue: everything here is a plain function over plain data so the behaviour the
// management view depends on can be unit-tested directly.
import { type CapabilityKey, modelHasCapability } from '../capabilities'
import { hasCapabilityOverrides, mergeCapabilities } from './overrides'
import type { InferenceDefaults, SamplingProfile } from '@/types/shared'
import {
  type ModelCapabilityValues,
  type ModelEntry,
  type ModelServiceBackend,
  type ModelSource,
  type ModelUseCase,
  type ScannedModel,
} from './types'

/**
 * Downloaded models are stored with `/` replaced by `---` (see
 * `service/utils.py`), sometimes only in the repo root (`owner---repo/file.gguf`)
 * and sometimes throughout (`owner---repo---file.onnx`), and with OS path
 * separators that differ per platform. Collapsing all of those to `/` gives one
 * key that a catalog name and its on-disk form both reduce to, which is how a
 * scanned file is matched to its catalog entry.
 */
export function normalizeModelKey(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/---/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .toLowerCase()
}

/** Stable row identity. The same file name can exist under two path keys. */
export function modelEntryId(pathKey: string, name: string): string {
  return `${pathKey}:${normalizeModelKey(name)}`
}

/** What the pickers already display: the last path segment. */
export function modelLabel(name: string): string {
  return name.split('/').at(-1) ?? name
}

/** Human-readable form of an on-disk name (`---` and separators become `/`). */
export function readableModelName(name: string): string {
  return name.replace(/\\/g, '/').replace(/---/g, '/')
}

/**
 * `model_config.json` and the presets both carry historical aliases for the same
 * directory (`loras`/`lora`, `checkpoint`/`checkpoints`). Canonicalising avoids
 * listing one file twice under two path keys.
 */
export function canonicalPathKey(pathKey: string): string {
  if (pathKey === 'loras') return 'lora'
  if (pathKey === 'checkpoint') return 'checkpoints'
  return pathKey
}

/** Chat-store model type + backend mapped onto a scan/download path key. */
export function pathKeyForCatalogModel(
  type: string,
  backend: string | undefined,
): { pathKey: string; useCase: ModelUseCase; serviceBackend: ModelServiceBackend } | undefined {
  if (type === 'llamaCPP') {
    return { pathKey: 'ggufLLM', useCase: 'llm', serviceBackend: 'llama_cpp' }
  }
  if (type === 'openVINO') {
    return { pathKey: 'openvinoLLM', useCase: 'llm', serviceBackend: 'openvino' }
  }
  if (type === 'embedding') {
    // The embedding directory has one sub-directory per backend, so an embedding
    // model without a backend can't be placed and is not actionable here.
    if (backend === 'llamaCPP') {
      return { pathKey: 'embedding', useCase: 'embedding', serviceBackend: 'llama_cpp' }
    }
    if (backend === 'openVINO') {
      return { pathKey: 'embedding', useCase: 'embedding', serviceBackend: 'openvino' }
    }
  }
  // 'cloud' models are remote and 'undefined' ones can't be placed on disk.
  return undefined
}

/** The `models.ts` shape this module consumes, kept structural to avoid a store import. */
export type CatalogModelInput = ModelCapabilityValues & {
  name: string
  type: string
  backend?: string
  downloaded: boolean
  isPredefined?: boolean
  /** Added by the user (has custom metadata) rather than found in the catalog. */
  isCustom?: boolean
  /** Publisher recommendations, shown read-only. See `ModelEntry`. */
  inferenceDefaults?: InferenceDefaults
  llamaCppArgs?: string
}

/**
 * A user-added model stays `custom` once its files are there: being downloaded
 * says nothing about who added it, and treating it as a plain disk find took
 * "remove from list" away the moment the download finished.
 */
function sourceOf(model: CatalogModelInput): ModelSource {
  if (model.isPredefined) return 'catalog'
  if (model.isCustom) return 'custom'
  // Neither in the catalog nor on disk: added by hand, its metadata since lost.
  return model.downloaded ? 'disk' : 'custom'
}

export type RequiredModelInput = {
  presetName: string
  type: string
  model: string
  additionalLicenceLink?: string
}

/**
 * A speech model the app knows about. Unlike LLM and media models these are not
 * in a catalog file or a preset — each is a constant a feature loads — so the
 * feature that needs it is what "used by" reports.
 */
export type SpeechModelInput = {
  name: string
  /** `STT` or `TTS`; also the download API's `type`. */
  pathKey: string
  /** The feature that loads it, e.g. "Speech To Text". */
  usedBy: string
  /**
   * The service that runs it. Speech weights all live in the OpenVINO model
   * directories, but only the OVMS ones actually need that backend — Qwen3-TTS
   * has its own sidecar — and the difference decides what an NVIDIA install can
   * use at all.
   */
  serviceBackend: ModelServiceBackend
}

export type ModelPreferencesInput = {
  favorite?: boolean
  capabilities?: Partial<ModelCapabilityValues>
}

export type BuildEntriesInput = {
  /** LLM + embedding models from `store/models.ts` (already merged and downloaded-checked). */
  catalogModels: CatalogModelInput[]
  /** Everything found on disk, from the `scanModelLibrary` IPC. */
  scanned: ScannedModel[]
  /** Flattened `requiredModels` across all presets — the media catalog. */
  requiredModels: RequiredModelInput[]
  /** The speech models the STT/TTS features load. */
  speechModels: SpeechModelInput[]
  /** User preferences keyed by `ModelEntry.id`. */
  preferences: Record<string, ModelPreferencesInput>
}

type ScanIndex = Map<string, ScannedModel>

function indexScan(scanned: ScannedModel[]): ScanIndex {
  const index: ScanIndex = new Map()
  for (const model of scanned) {
    const id = modelEntryId(canonicalPathKey(model.pathKey), model.name)
    // A model can appear twice when two path-key aliases point at one directory;
    // the first hit wins so the row stays stable across scans.
    if (!index.has(id)) index.set(id, model)
  }
  return index
}

/**
 * Build the unified row list.
 *
 * LLM and embedding rows come from the chat catalog, which already computes
 * `downloaded` correctly, and are only *enriched* with size/mtime/path from the
 * scan. Media and speech rows are built from the scan plus preset
 * `requiredModels`, since no catalog file describes them.
 */
export function buildEntries(input: BuildEntriesInput): ModelEntry[] {
  const scanIndex = indexScan(input.scanned)
  const entries: ModelEntry[] = []
  const seen = new Set<string>()

  const requiredBy = new Map<string, string[]>()
  const requiredMeta = new Map<string, RequiredModelInput>()
  const addRequiredBy = (id: string, requiredByName: string) => {
    const names = requiredBy.get(id) ?? []
    if (!names.includes(requiredByName)) names.push(requiredByName)
    requiredBy.set(id, names)
  }
  for (const required of input.requiredModels) {
    const id = modelEntryId(canonicalPathKey(required.type), required.model)
    addRequiredBy(id, required.presetName)
    if (!requiredMeta.has(id)) requiredMeta.set(id, required)
  }
  const speechById = new Map<string, SpeechModelInput>()
  for (const speech of input.speechModels) {
    const id = modelEntryId(speech.pathKey, speech.name)
    addRequiredBy(id, speech.usedBy)
    if (!speechById.has(id)) speechById.set(id, speech)
  }

  const push = (
    entry: Omit<
      ModelEntry,
      'id' | 'label' | 'favorite' | 'capabilities' | 'hasCapabilityOverrides' | 'requiredBy'
    > & {
      baseCapabilities: ModelCapabilityValues
    },
  ) => {
    const id = modelEntryId(entry.pathKey, entry.name)
    if (seen.has(id)) return
    seen.add(id)
    const preferences = input.preferences[id]
    const { baseCapabilities, ...rest } = entry
    entries.push({
      ...rest,
      id,
      label: modelLabel(entry.name),
      capabilities: mergeCapabilities(baseCapabilities, preferences?.capabilities),
      hasCapabilityOverrides: hasCapabilityOverrides(preferences?.capabilities),
      favorite: preferences?.favorite === true,
      requiredBy: requiredBy.get(id) ?? [],
    })
  }

  for (const model of input.catalogModels) {
    const placement = pathKeyForCatalogModel(model.type, model.backend)
    if (!placement) continue
    const id = modelEntryId(placement.pathKey, model.name)
    const onDisk = scanIndex.get(id)
    push({
      name: model.name,
      useCase: placement.useCase,
      pathKey: placement.pathKey,
      serviceBackend: placement.serviceBackend,
      source: sourceOf(model),
      downloaded: model.downloaded,
      absolutePath: onDisk?.absolutePath,
      sizeBytes: onDisk?.sizeBytes,
      modifiedAt: onDisk?.modifiedAt,
      isDirectory: onDisk?.isDirectory,
      inferenceDefaults: model.inferenceDefaults,
      llamaCppArgs: model.llamaCppArgs,
      // Through `mergeCapabilities` rather than field by field, so a capability
      // added to `CAPABILITY_KEYS` reaches the row without a second edit here.
      baseCapabilities: mergeCapabilities(model),
    })
  }

  // Media/speech models present on disk. LLM/embedding path keys are skipped
  // because the chat catalog above already covers them (including models found
  // only on disk, which it merges in as non-predefined entries).
  for (const model of input.scanned) {
    if (model.useCase === 'llm' || model.useCase === 'embedding') continue
    const pathKey = canonicalPathKey(model.pathKey)
    const id = modelEntryId(pathKey, model.name)
    const known = requiredMeta.get(id) ?? speechById.get(id)
    push({
      // Prefer the catalog spelling: on disk the repo separator is `---`.
      name:
        requiredMeta.get(id)?.model ?? speechById.get(id)?.name ?? readableModelName(model.name),
      useCase: model.useCase,
      pathKey,
      // A scan target tags a whole directory with one backend, but the STT/TTS
      // trees are shared: OVMS Whisper, Qwen3-TTS and the standalone Whisper
      // sidecar all live under them. Trust the speech catalog's backend when it
      // knows this repo, so a downloaded sidecar model does not get mislabelled
      // as OpenVINO — which would drop it from `entriesForProductMode` on NVIDIA.
      serviceBackend: speechById.get(id)?.serviceBackend ?? model.serviceBackend,
      source: known ? 'catalog' : 'disk',
      downloaded: true,
      absolutePath: model.absolutePath,
      sizeBytes: model.sizeBytes,
      modifiedAt: model.modifiedAt,
      isDirectory: model.isDirectory,
      additionalLicenseLink: requiredMeta.get(id)?.additionalLicenceLink,
      baseCapabilities: {},
    })
  }

  // Media models a preset needs but which aren't on disk yet — the downloadable
  // side of the media catalog.
  for (const [id, required] of requiredMeta) {
    if (seen.has(id)) continue
    const pathKey = canonicalPathKey(required.type)
    push({
      name: required.model,
      useCase: 'media',
      pathKey,
      serviceBackend: 'comfyui',
      source: 'catalog',
      downloaded: false,
      additionalLicenseLink: required.additionalLicenceLink,
      baseCapabilities: {},
    })
  }

  // Speech models the STT/TTS features would download on first use. Listing them
  // is the only way a user can see, pre-fetch or reclaim them before that first
  // use puts them on disk.
  for (const [id, speech] of speechById) {
    if (seen.has(id)) continue
    push({
      name: speech.name,
      useCase: 'speech',
      pathKey: speech.pathKey,
      serviceBackend: speech.serviceBackend,
      source: 'catalog',
      downloaded: false,
      baseCapabilities: {},
    })
  }

  return entries
}

export type ModelDownloadState = 'all' | 'downloaded' | 'notDownloaded'

/**
 * What the left-hand sidebar filters by: a use case, everything, or the user's
 * favorites. Favorites are not a use case — a favorite model still has one — so
 * they ride alongside rather than inside `ModelUseCase`.
 */
export type ModelCategory = ModelUseCase | 'all' | 'favorites'

export type ModelLibraryFilters = {
  search: string
  useCase: ModelCategory
  backend: ModelServiceBackend | 'all'
  capabilities: CapabilityKey[]
  downloadState: ModelDownloadState
}

export const DEFAULT_FILTERS: ModelLibraryFilters = {
  search: '',
  useCase: 'all',
  backend: 'all',
  capabilities: [],
  downloadState: 'all',
}

/**
 * Same search semantics as the chat model picker: case-insensitive substring on
 * the visible label, so a user's muscle memory carries over between the two.
 */
export function matchesSearch(entry: ModelEntry, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return entry.label.toLowerCase().includes(needle)
}

export function filterEntries(
  entries: ModelEntry[],
  filters: ModelLibraryFilters,
  options: { alwaysInclude?: ReadonlySet<string> } = {},
): ModelEntry[] {
  return entries.filter((entry) => {
    if (options.alwaysInclude?.has(entry.id)) return true
    if (filters.useCase === 'favorites' && !entry.favorite) return false
    if (
      filters.useCase !== 'all' &&
      filters.useCase !== 'favorites' &&
      entry.useCase !== filters.useCase
    )
      return false
    if (filters.backend !== 'all' && entry.serviceBackend !== filters.backend) return false
    if (filters.downloadState === 'downloaded' && !entry.downloaded) return false
    if (filters.downloadState === 'notDownloaded' && entry.downloaded) return false
    if (!matchesSearch(entry, filters.search)) return false
    // AND across selected capabilities; deselected ones don't filter — matching
    // the model picker's capability row.
    for (const key of filters.capabilities) {
      if (!modelHasCapability(entry.capabilities, key)) return false
    }
    return true
  })
}

export type ModelSortKey = 'name' | 'size' | 'modified'
export type ModelSortDirection = 'asc' | 'desc'

export type ModelSort = {
  key: ModelSortKey
  direction: ModelSortDirection
}

export const DEFAULT_SORT: ModelSort = { key: 'name', direction: 'asc' }

/**
 * Favorites are always pinned to the top, then the chosen column, then models on
 * disk before ones that still need downloading, then name as a stable tiebreak.
 *
 * The direction only applies to the column being sorted on. Rows whose size or
 * mtime is equal (or missing) fall through to the name tiebreak, which stays
 * ascending either way: reversing it too would shuffle the many blank-size rows
 * on every direction toggle, which reads as the table losing its order.
 */
export function sortEntries(entries: ModelEntry[], sort: ModelSort): ModelEntry[] {
  const factor = sort.direction === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    if (sort.key === 'size') {
      const diff = (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)
      if (diff !== 0) return diff * factor
    } else if (sort.key === 'modified') {
      const diff = (a.modifiedAt ?? -1) - (b.modifiedAt ?? -1)
      if (diff !== 0) return diff * factor
    }
    if (a.downloaded !== b.downloaded) return a.downloaded ? -1 : 1
    return a.label.localeCompare(b.label) * (sort.key === 'name' ? factor : 1)
  })
}

/**
 * Drop what an NVIDIA install cannot run. Those machines never get the OpenVINO
 * backend, so an OpenVINO model there is dead weight: it cannot be loaded, and
 * offering it only invites a multi-GB download that will never be used. Qwen3-TTS
 * keeps its own backend precisely so it survives this filter — it runs on CUDA.
 */
export function entriesForProductMode(entries: ModelEntry[], isNvidia: boolean): ModelEntry[] {
  if (!isNvidia) return entries
  return entries.filter((entry) => entry.serviceBackend !== 'openvino')
}

/**
 * The backends actually represented in a set of entries, in the order the labels
 * declare them. The toolbar offers only these: a "Backend" list that includes
 * ComfyUI while the Embedding category is selected filters every row away, which
 * reads as a broken table rather than an empty filter.
 */
export function availableBackends(entries: ModelEntry[]): ModelServiceBackend[] {
  const present = new Set(entries.map((entry) => entry.serviceBackend))
  return (Object.keys(BACKEND_LABELS) as ModelServiceBackend[]).filter((backend) =>
    present.has(backend),
  )
}

/** Same idea for the status filter: only the states some entry is actually in. */
export function availableDownloadStates(
  entries: ModelEntry[],
): Exclude<ModelDownloadState, 'all'>[] {
  const states: Exclude<ModelDownloadState, 'all'>[] = []
  if (entries.some((entry) => entry.downloaded)) states.push('downloaded')
  if (entries.some((entry) => !entry.downloaded)) states.push('notDownloaded')
  return states
}

export function countByUseCase(entries: ModelEntry[]): Record<ModelCategory, number> {
  const counts: Record<ModelCategory, number> = {
    all: 0,
    favorites: 0,
    llm: 0,
    embedding: 0,
    media: 0,
    speech: 0,
  }
  for (const entry of entries) {
    counts.all += 1
    counts[entry.useCase] += 1
    if (entry.favorite) counts.favorites += 1
  }
  return counts
}

/**
 * Wire names rather than prose: these are the names the model cards the numbers
 * come from use, and the names they travel under in the request.
 */
const SAMPLING_LABELS: Readonly<Record<keyof SamplingProfile, string>> = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
  repetitionPenalty: 'repetition_penalty',
}

function describeSampling(profile: SamplingProfile | undefined): string {
  if (!profile) return ''
  return (Object.keys(SAMPLING_LABELS) as (keyof SamplingProfile)[])
    .filter((key) => profile[key] !== undefined)
    .map((key) => `${SAMPLING_LABELS[key]} ${profile[key]}`)
    .join(', ')
}

/**
 * The publisher's recommended sampling as one line, per mode where it differs.
 * Read-only: it explains sampling the user never sees applied, so leaving it out
 * made a model's behaviour unexplainable from the management view.
 */
export function describeInferenceDefaults(defaults: InferenceDefaults | undefined): string {
  if (!defaults) return ''
  const { thinking, instruct, reasoningEffort, ...base } = defaults
  const parts: string[] = []
  const baseLine = describeSampling(base)
  if (baseLine) parts.push(baseLine)
  const thinkingLine = describeSampling(thinking)
  if (thinkingLine) parts.push(`thinking: ${thinkingLine}`)
  const instructLine = describeSampling(instruct)
  if (instructLine) parts.push(`instruct: ${instructLine}`)
  if (reasoningEffort) parts.push(`reasoning_effort ${reasoningEffort}`)
  return parts.join(' · ')
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${SIZE_UNITS[exponent]}`
}

/**
 * The locale the library formats against: the i18n store's string table plus the
 * active language tag. Both are needed — the relative-time wording comes from the
 * table, and the absolute-date fallback has to follow the language the user picked
 * in the app rather than whatever the OS is set to.
 */
export type ModelLibraryLocale = {
  strings: Record<string, string>
  tag: string
}

export function formatModifiedAt(
  modifiedAt: number | undefined,
  locale: ModelLibraryLocale,
  now = Date.now(),
): string {
  if (modifiedAt === undefined) return '—'
  const relative = (key: string, count: number) =>
    (locale.strings[key] ?? '').replace('{count}', String(count))
  const seconds = Math.max(0, Math.round((now - modifiedAt) / 1000))
  if (seconds < 60) return locale.strings.MODEL_MANAGER_TIME_JUST_NOW ?? ''
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return relative('MODEL_MANAGER_TIME_MINUTES', minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return relative('MODEL_MANAGER_TIME_HOURS', hours)
  const days = Math.round(hours / 24)
  if (days < 31) return relative('MODEL_MANAGER_TIME_DAYS', days)
  return new Date(modifiedAt).toLocaleDateString(locale.tag)
}

const USE_CASE_LABEL_KEYS: Record<ModelUseCase, string> = {
  llm: 'MODEL_MANAGER_USE_CASE_LLM',
  embedding: 'MODEL_MANAGER_USE_CASE_EMBEDDING',
  media: 'MODEL_MANAGER_USE_CASE_MEDIA',
  speech: 'MODEL_MANAGER_USE_CASE_SPEECH',
}

export function useCaseLabel(useCase: ModelUseCase, locale: ModelLibraryLocale): string {
  return locale.strings[USE_CASE_LABEL_KEYS[useCase]] ?? ''
}

/**
 * Not translated: every one of these is the product name of the service that runs
 * the weights, so it reads the same in every language.
 */
export const BACKEND_LABELS: Record<ModelServiceBackend, string> = {
  llama_cpp: 'Llama.cpp',
  openvino: 'OpenVINO',
  comfyui: 'ComfyUI',
  qwen3_tts: 'Qwen3-TTS',
  whisper: 'Whisper',
}

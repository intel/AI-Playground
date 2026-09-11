import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useModels } from './models'
import { useModelPreferences } from './modelPreferences'
import { usePresets } from './presets'
import { useDialogStore } from './dialogs'
import { useGlobalSetup } from './globalSetup'
import { useTextInference } from './textInference'
import { useProductMode } from './productMode'
import { useErrors } from './errors'
import { WHISPER_OVMS_MODELS, WHISPER_STANDALONE_MODELS } from '../whisperConstants'
import { SPEECHT5_MODEL_NAME } from './textToSpeech'
import { QWEN3_TTS_MODEL_REPOS } from '../qwen3TtsConstants'
import { createAppError } from '../errors/appError'
import { entriesToDownloadParams } from '../models/downloadParams'
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  availableBackends,
  availableDownloadStates,
  buildEntries,
  countByUseCase,
  entriesForProductMode,
  filterEntries,
  sortEntries,
  type ModelLibraryFilters,
  type ModelSort,
  type ModelSortKey,
  type RequiredModelInput,
  type SpeechModelInput,
} from '../models/library'
import type { ModelCapabilityValues, ModelEntry, ScannedModel } from '../models/types'

/**
 * The model management view's state: the unified entry list, its filters and
 * selection, and the actions on a model (reveal, delete, favorite, edit
 * capabilities, download).
 *
 * Derivation and filtering live in `assets/js/models/library.ts` as pure
 * functions; this store only holds reactive state and talks to the other stores.
 */
export const useModelLibrary = defineStore('modelLibrary', () => {
  const models = useModels()
  const modelPreferences = useModelPreferences()
  const presets = usePresets()
  const dialogs = useDialogStore()
  const globalSetup = useGlobalSetup()
  const textInference = useTextInference()
  const productMode = useProductMode()
  const errors = useErrors()

  const scanned = ref<ScannedModel[]>([])
  const failedPathKeys = ref<string[]>([])
  const scanning = ref(false)
  const deleting = ref(false)
  const filters = ref<ModelLibraryFilters>({ ...DEFAULT_FILTERS })
  const sort = ref<ModelSort>({ ...DEFAULT_SORT })
  const selection = ref<Set<string>>(new Set())

  /**
   * Media models come from the presets rather than a catalog file: the
   * downloadable set is exactly "models some preset can use", which needs no
   * second list to maintain and yields the "used by" column for free.
   */
  const requiredModels = computed<RequiredModelInput[]>(() =>
    presets.presets.flatMap((preset) =>
      (preset.requiredModels ?? []).map((required) => ({
        presetName: preset.name,
        type: required.type,
        model: required.model,
        additionalLicenceLink: required.additionalLicenceLink,
      })),
    ),
  )

  /**
   * The speech models the app can load. They are downloaded on first use by the
   * STT/TTS features rather than picked from a catalog, so without this list they
   * are invisible until that happens, and there is no way to pre-fetch one or to
   * reclaim its disk space.
   */
  const speechModels = computed<SpeechModelInput[]>(() => [
    // Whisper and SpeechT5 are served by OVMS, so an NVIDIA install — which never
    // gets the OpenVINO backend — cannot run them at all. Qwen3-TTS has its own
    // sidecar and runs on CUDA there, so it stays listed.
    ...(nvidiaMode.value
      ? []
      : [
          // Every model the OpenVINO Whisper picker offers, so a user can pre-fetch
          // or reclaim any of them — not just the one currently selected.
          ...WHISPER_OVMS_MODELS.map((m) => ({
            name: m.repo,
            pathKey: 'STT',
            usedBy: `Speech To Text (OpenVINO ${m.label})`,
            serviceBackend: 'openvino' as const,
          })),
          {
            name: SPEECHT5_MODEL_NAME,
            pathKey: 'TTS',
            usedBy: 'Text To Speech',
            serviceBackend: 'openvino' as const,
          },
        ]),
    {
      name: QWEN3_TTS_MODEL_REPOS.customVoice,
      pathKey: 'TTS',
      usedBy: 'Text To Speech (Qwen3-TTS custom voice)',
      serviceBackend: 'qwen3_tts',
    },
    {
      name: QWEN3_TTS_MODEL_REPOS.voiceDesign,
      pathKey: 'TTS',
      usedBy: 'Text To Speech (Qwen3-TTS voice design)',
      serviceBackend: 'qwen3_tts',
    },
    // The standalone (torch) Whisper sidecar runs on CUDA too, so unlike OVMS
    // Whisper these stay listed on NVIDIA. This engine is the one place STT does
    // have a model picker, so all three are listed.
    ...WHISPER_STANDALONE_MODELS.map((m) => ({
      name: m.repo,
      pathKey: 'STT',
      usedBy: `Speech To Text (standalone ${m.label})`,
      serviceBackend: 'whisper' as const,
    })),
  ])

  const nvidiaMode = computed(() => productMode.isNvidiaModeSelected)

  // On an NVIDIA box this leaves Llama.cpp (and the CUDA sidecars), which is also
  // what locks the toolbar's backend filter — there is nothing else to pick.
  const entries = computed<ModelEntry[]>(() =>
    entriesForProductMode(
      buildEntries({
        catalogModels: models.models,
        scanned: scanned.value,
        requiredModels: requiredModels.value,
        speechModels: speechModels.value,
        preferences: modelPreferences.preferences,
      }),
      nvidiaMode.value,
    ),
  )

  const useCaseCounts = computed(() => countByUseCase(entries.value))

  /**
   * Everything in the selected sidebar category, before the toolbar's own
   * filters. This is what the backend and status dropdowns offer options from —
   * they list what the category actually contains rather than every value the
   * app knows, so no choice can filter the table down to nothing.
   */
  const categoryEntries = computed(() =>
    filterEntries(entries.value, { ...DEFAULT_FILTERS, useCase: filters.value.useCase }),
  )

  const backendOptions = computed(() => availableBackends(categoryEntries.value))
  const downloadStateOptions = computed(() => availableDownloadStates(categoryEntries.value))

  const visibleEntries = computed(() =>
    sortEntries(filterEntries(entries.value, filters.value), sort.value),
  )

  const selectedEntries = computed(() =>
    visibleEntries.value.filter((entry) => selection.value.has(entry.id)),
  )

  const selectedDownloadable = computed(() =>
    selectedEntries.value.filter((entry) => !entry.downloaded),
  )

  const selectedDeletable = computed(() =>
    selectedEntries.value.filter((entry) => entry.downloaded && entry.absolutePath),
  )

  const allVisibleSelected = computed(
    () =>
      visibleEntries.value.length > 0 &&
      selectedEntries.value.length === visibleEntries.value.length,
  )

  /** Set when a destructive action is impossible, so the UI can explain itself. */
  const readOnly = computed(() => globalSetup.state.modelFolderReadOnly === true)

  function byId(id: string): ModelEntry | undefined {
    return entries.value.find((entry) => entry.id === id)
  }

  async function refresh() {
    scanning.value = true
    try {
      const scan = await window.electronAPI.scanModelLibrary()
      scanned.value = scan.models
      failedPathKeys.value = scan.failedPathKeys
      if (scan.failedPathKeys.length > 0) {
        // Report but keep going: one unreadable directory must not blank the table.
        errors.report(
          createAppError({
            category: 'model',
            code: 'model/scan-failed',
            severity: 'warning',
            userMessage: `Some model folders could not be read: ${scan.failedPathKeys.join(', ')}.`,
          }),
        )
      }
      await models.refreshModels()
    } catch (error) {
      errors.report(error, {
        category: 'model',
        code: 'model/scan-failed',
        userMessage: 'Could not read the model folders.',
      })
    } finally {
      scanning.value = false
    }
  }

  function setFilters(patch: Partial<ModelLibraryFilters>) {
    filters.value = { ...filters.value, ...patch }
    // Switching category can strand a backend or status the new category has
    // none of — the dropdown would show a value it no longer offers and the
    // table would be empty — so those fall back to "any".
    if (patch.useCase !== undefined) {
      const next = { ...filters.value }
      if (next.backend !== 'all' && !backendOptions.value.includes(next.backend)) {
        next.backend = 'all'
      }
      if (
        next.downloadState !== 'all' &&
        !downloadStateOptions.value.includes(next.downloadState)
      ) {
        next.downloadState = 'all'
      }
      filters.value = next
    }
    // Selecting a row and then filtering it away would hide what a batch action
    // is about to act on, so the selection is pruned to what stays visible.
    pruneSelection()
  }

  function resetFilters() {
    filters.value = { ...DEFAULT_FILTERS }
    pruneSelection()
  }

  function toggleSortKey(key: ModelSortKey) {
    sort.value =
      sort.value.key === key
        ? { key, direction: sort.value.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
  }

  function pruneSelection() {
    const visible = new Set(visibleEntries.value.map((entry) => entry.id))
    selection.value = new Set([...selection.value].filter((id) => visible.has(id)))
  }

  function toggleSelected(id: string) {
    const next = new Set(selection.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selection.value = next
  }

  function toggleSelectAllVisible() {
    selection.value = allVisibleSelected.value
      ? new Set()
      : new Set(visibleEntries.value.map((entry) => entry.id))
  }

  function clearSelection() {
    selection.value = new Set()
  }

  function setFavorite(id: string, favorite: boolean) {
    modelPreferences.setFavorite(id, favorite)
  }

  function saveCapabilities(id: string, capabilities: Partial<ModelCapabilityValues>) {
    modelPreferences.setCapabilities(id, capabilities)
    // Chat pickers and the request kwargs read from `models.models`, so the edit
    // has to be folded back in before it shows up anywhere else.
    return models.refreshModels()
  }

  function resetCapabilities(id: string) {
    modelPreferences.resetCapabilities(id)
    return models.refreshModels()
  }

  async function revealInFolder(id: string) {
    const entry = byId(id)
    if (!entry?.absolutePath) return
    // The IPC call can reject outright (the handler throwing, the channel gone),
    // not only resolve with `success: false` — an unhandled rejection here would
    // leave the user with a menu item that silently did nothing.
    const reveal = async () => {
      try {
        return await window.electronAPI.showModelInFolder(entry.absolutePath!)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const result = await reveal()
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'model',
          code: 'model/reveal-failed',
          userMessage: `Could not open the folder for ${entry.label}.`,
          technicalMessage: result.error,
        }),
      )
    }
  }

  /** Drop a user-added entry from the catalog (files, if any, are unaffected). */
  async function removeFromList(id: string) {
    const entry = byId(id)
    if (!entry || entry.source !== 'custom') return
    await models.removeCustomModel(entry.name)
    modelPreferences.reset(id)
    selection.value = new Set([...selection.value].filter((selected) => selected !== id))
  }

  /**
   * Permanently delete the given models' files. Irreversible by design — the
   * space is reclaimed immediately — so the caller is expected to have confirmed
   * with the user first (see DeleteModelDialog).
   */
  async function deleteFromDisk(ids: string[]): Promise<{ deleted: number; failed: number }> {
    if (readOnly.value) return { deleted: 0, failed: ids.length }
    deleting.value = true
    let deleted = 0
    let failed = 0
    try {
      for (const id of ids) {
        const entry = byId(id)
        if (!entry?.absolutePath) continue
        // A rejected call counts as a failed path like any other, so one bad
        // entry cannot abandon the rest of a batch delete half-done.
        let result: { success: boolean; error?: string }
        try {
          result = await window.electronAPI.deleteModelPath(entry.absolutePath)
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (result.success) {
          deleted += 1
          // A model that is gone should not stay selected in Chat Settings.
          textInference.clearSelectionOfModel(entry.name)
        } else {
          failed += 1
          errors.report(
            createAppError({
              category: 'model',
              code: 'model/delete-failed',
              userMessage: `Could not delete ${entry.label}. ${
                result.error?.includes('EBUSY') || result.error?.includes('resource busy')
                  ? 'It looks like the model is still loaded — stop the backend and try again.'
                  : ''
              }`.trim(),
              technicalMessage: result.error,
            }),
          )
        }
      }
    } finally {
      deleting.value = false
      await refresh()
      clearSelection()
    }
    return { deleted, failed }
  }

  /** Queue downloads through the existing (already multi-model) download dialog. */
  function download(entriesToDownload: ModelEntry[]) {
    const params = entriesToDownloadParams(entriesToDownload, models.getModelPath)
    if (params.length === 0) return
    dialogs.showDownloadDialog(
      params,
      () => {
        refresh()
        clearSelection()
      },
      () => refresh(),
    )
  }

  function downloadOne(id: string) {
    const entry = byId(id)
    if (entry) download([entry])
  }

  function downloadSelected() {
    download(selectedDownloadable.value)
  }

  return {
    entries,
    visibleEntries,
    useCaseCounts,
    backendOptions,
    downloadStateOptions,
    filters,
    sort,
    selection,
    selectedEntries,
    selectedDownloadable,
    selectedDeletable,
    allVisibleSelected,
    scanning,
    deleting,
    failedPathKeys,
    readOnly,
    byId,
    refresh,
    setFilters,
    resetFilters,
    toggleSortKey,
    toggleSelected,
    toggleSelectAllVisible,
    clearSelection,
    setFavorite,
    saveCapabilities,
    resetCapabilities,
    revealInFolder,
    removeFromList,
    deleteFromDisk,
    download,
    downloadOne,
    downloadSelected,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useModelLibrary, import.meta.hot))
}

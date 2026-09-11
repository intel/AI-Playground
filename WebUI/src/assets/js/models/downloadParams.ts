// Turn selected library rows into the `DownloadModelParam[]` that
// `dialogs.showDownloadDialog` already knows how to handle, so batch download
// needs no new download machinery.
import type { ModelEntry, ModelServiceBackend } from './types'

/**
 * The download API knows only the three backends that own a model directory.
 * Qwen3-TTS and the standalone Whisper sidecar run on their own services but their
 * weights live in the OpenVINO tree, so that is what decides where they are
 * fetched to — the same `type`/`backend` pair the features themselves download
 * with (`models.getMissingTranscriptionModel`).
 */
function downloadBackendOf(backend: ModelServiceBackend): 'comfyui' | 'llama_cpp' | 'openvino' {
  return backend === 'qwen3_tts' || backend === 'whisper' ? 'openvino' : backend
}

/** Resolves the on-disk directory for a download, i.e. `models.getModelPath`. */
export type ModelPathResolver = (type: string, backend: string) => string

/**
 * A vision llama.cpp model is useless without its multimodal projector, so the
 * companion repo is queued alongside it — the same rule
 * `textInference.getDownloadParamsForCurrentModelIfRequired` applies for the
 * active chat model.
 *
 * Entries are deduplicated by `repo_id` because `DownloadDialog` keys its rows on
 * it, and an mmproj shared by two models would otherwise appear twice.
 */
export function entriesToDownloadParams(
  entries: readonly ModelEntry[],
  resolvePath: ModelPathResolver,
): DownloadModelParam[] {
  const params: DownloadModelParam[] = []
  const seen = new Set<string>()

  const add = (repoId: string, entry: ModelEntry) => {
    if (seen.has(repoId)) return
    seen.add(repoId)
    const backend = downloadBackendOf(entry.serviceBackend)
    params.push({
      repo_id: repoId,
      type: entry.pathKey,
      backend,
      model_path: resolvePath(entry.pathKey, backend),
      additionalLicenseLink: entry.additionalLicenseLink,
    })
  }

  for (const entry of entries) {
    if (entry.downloaded) continue
    add(entry.name, entry)
    if (entry.capabilities.mmproj) add(entry.capabilities.mmproj, entry)
  }

  return params
}

import type { RequiredModel } from '@/lib/presetSchemas'

/**
 * A model the renderer's pre-flight found missing, as it must be handed to the
 * download dialog: the check result (repo id, resolved path), not the preset's
 * declaration. Structurally a subset of the renderer's ambient
 * `DownloadModelParam`, so it flows straight into `permissions.requestDownload`.
 */
export type ArtifactMissingModel = {
  repo_id: string
  type: string
  backend: 'comfyui' | 'llama_cpp' | 'openvino'
  model_path: string
  additionalLicenseLink?: string
}

/**
 * Main → renderer requests the artifact pipeline needs answered by code that
 * lives renderer-side: the model pre-flight (models store + HF token) and the
 * download-consent prompt (permissions layer).
 *
 * The renderer replies through `electronAPI.artifact.respond` with a
 * `MediaResponsePayload` carrying the same `requestId`; `{ progress: true }`
 * pings re-arm long-running waits (the consent download) without settling.
 */
export type MediaRequestBody =
  | { kind: 'artifact-check-models'; requiredModels: RequiredModel[] }
  | { kind: 'artifact-consent'; models: ArtifactMissingModel[] }

export type MediaRequestPayload = MediaRequestBody & { requestId: string }

export type MediaResponsePayload =
  | { requestId: string; progress: true }
  | { requestId: string; result: unknown }
  | { requestId: string; error: string }

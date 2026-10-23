/** Written under ComfyUI install dir after a successful dependency install. */
export const COMFYUI_DEPS_MARKER_FILENAME = '.aipg-comfyui-deps.json'

export type ComfyUiDepsMarker = {
  mode: 'locked' | 'flexible'
  /** Normalized ref (tag or short hash) used for this install */
  revision: string
}

/**
 * Normalize a user or git ref for comparison (trim, lowercase hex hashes).
 */
export function normalizeComfyUiRef(ref: string): string {
  return ref.trim().toLowerCase()
}

/**
 * Use bundled `uv.lock` when the requested ref matches the shipped ComfyUI ref
 * (from `getBundledComfyUiGitRefSync()` in remoteUpdates — same as backend-versions.json).
 */
export function useLockedComfyUiDeps(revision: string, bundledComfyUiRef: string): boolean {
  return normalizeComfyUiRef(revision) === normalizeComfyUiRef(bundledComfyUiRef)
}

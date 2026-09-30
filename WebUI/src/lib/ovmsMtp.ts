// OpenVINO MTP is the model's own draft graph (`openvino_mtp_model.xml`), not a
// llama-server flag. The launch decides whether `--draft_model_path` is passed;
// the request then asks for this many drafted tokens. OVMS drafts 5 when the
// field is omitted, and a request that asks for them with no draft model fails.

export const OVMS_MTP_GRAPH_FILE = 'openvino_mtp_model.xml'

/** OVMS joins a relative `--draft_model_path` onto the graph directory, so `.` is the model folder. */
export const OVMS_MTP_DRAFT_PATH = '.'

/** Same draft length as llama.cpp's Qwen 3.6 `--spec-draft-n-max 2`. */
export const OVMS_MTP_ASSISTANT_TOKENS = 2

const STALE_NOTICE_PREFIX = 'aipg.ovmsMtpStaleNotice.'

export type OvmsMtpLaunch = {
  /** `.` to pass as `--draft_model_path`, or null to leave MTP off. */
  draftModelPath: string | null
  /** The folder is an older snapshot: MTP applies only after a delete and re-download. */
  stale: boolean
}

export function resolveOvmsMtpLaunch(options: {
  enableMtp: boolean
  deviceId: string
  folderExists: boolean
  mtpGraphExists: boolean
}): OvmsMtpLaunch {
  // NPU has no MTP. A model that does not ship the graph must not be pointed at
  // either — OVMS fails draft detection instead of serving the language model.
  if (!options.enableMtp || options.deviceId.startsWith('NPU')) {
    return { draftModelPath: null, stale: false }
  }
  // Missing folder is a first download: OVMS pulls the current repo, graph included.
  if (!options.folderExists || options.mtpGraphExists) {
    return { draftModelPath: OVMS_MTP_DRAFT_PATH, stale: false }
  }
  return { draftModelPath: null, stale: true }
}

/**
 * MTP launch flags. Prefix caching defaults on and is not supported with MTP,
 * so an armed launch turns it off. Other launches leave the default.
 */
export function ovmsMtpLaunchArgs(draftModelPath: string | null): string[] {
  if (!draftModelPath) return []
  return ['--draft_model_path', draftModelPath, '--enable_prefix_caching', 'false']
}

/** Request fields for a launch that did or did not pass `--draft_model_path`. */
export function ovmsMtpRequestFields(mtpArmed: boolean): Record<string, number> {
  if (!mtpArmed) return {}
  return { num_assistant_tokens: OVMS_MTP_ASSISTANT_TOKENS }
}

export function ovmsMtpStaleNoticeKey(modelRepoId: string): string {
  return STALE_NOTICE_PREFIX + modelRepoId
}

/**
 * Whether this model still needs its one stale-snapshot notice, and record it
 * so a later launch of the same folder stays quiet. A different repo id still
 * gets its own dialog.
 */
export function claimOvmsMtpStaleNotice(
  modelRepoId: string | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): boolean {
  if (!modelRepoId) return false
  const key = ovmsMtpStaleNoticeKey(modelRepoId)
  try {
    if (storage.getItem(key) === '1') return false
  } catch {
    // An unreadable store should not swallow the only notice.
  }
  try {
    storage.setItem(key, '1')
  } catch {
    // Showing it still counts for this session; the next launch may ask again.
  }
  return true
}

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { useBackendServices } from './store/backendServices'

/**
 * Renderer-side Phison KM (Knowledge Manager) RAG state — retrieval-mode toggle,
 * availability gating, and the context-size floor/stash logic that keeps KM's
 * "group + prefix always fits the window" guarantee intact across mode switches
 * and model changes.
 *
 * Kept out of textInference.ts as a plain factory (not a Pinia store) — a store
 * would create a circular dependency, since this state needs textInference's
 * contextSize/activePreset/backend, and textInference.ts is what calls this
 * factory. See aidaptiv-km-rag-review-scope.md §W1 for the full rationale.
 */

/**
 * Hard minimum context size for Phison KM group retrieval — not a recommendation.
 * A merged group is capped at ~13 000 tokens and the shared prefix must fit alongside
 * it, so below this the KV-cache prefix stops lining up and retrieval silently
 * truncates. Enforced continuously while KM mode is on (the settings input's `min`,
 * the contextSize clamp watcher, and preset load all use this same value), and KM is
 * reported unavailable outright when the model's own ceiling can't reach it.
 */
export const PHISON_KM_CONTEXT_FLOOR = 16384

/**
 * Shared RAG prefix used as the invariant front of every Phison KM system prompt.
 * Both warmup and actual inference must start with this exact string so the KV
 * cache prefix can be reused across presets and queries.
 * The preset's own systemPrompt is appended AFTER the document context block
 * (Approach A), keeping tool instructions / persona intact while preserving
 * the shared prefix for KV cache reuse.
 */
export const PHISON_KM_RAG_PREFIX =
  '/no_think You are a helpful AI assistant. Use the provided document context to answer questions accurately. If the context does not contain relevant information, say so.'

/**
 * Only the two preset flags this module actually reads — deliberately narrower
 * than the full ChatPreset type. Besides keeping the dependency surface honest,
 * this also sidesteps a TS complexity bail-out ("two different types with this
 * name exist, but they are unrelated") that showed up when this file tried to
 * structurally compare two separately-inferred instantiations of the full
 * (zod-inferred, discriminated-union-derived) ChatPreset type across the module
 * boundary — a unidirectional "has at least these fields" check avoids it.
 */
export type ActivePresetKmFlags = {
  supportsPhisonKmRag?: boolean
  requiresPhison?: boolean
}

export type PhisonKmRagDeps = {
  contextSize: Ref<number>
  /**
   * What the user (or the preset) actually asked for, before any model ceiling is
   * applied. `contextSize` is the bounded result and is what gets allocated; this is
   * the intent it was derived from, so the clamp below can be re-run from the same
   * starting point every time the bounds move rather than compounding on its own
   * previous output. Without it the clamp is a one-way ratchet: selecting a 2048-token
   * model once pins the setting at 2048, and every larger model chosen afterwards is
   * still served a 2048 window — which is how OVMS came to be started with
   * `--max_prompt_len 2048` for an 8B model.
   */
  requestedContextSize: Ref<number>
  maxContextSizeFromModel: ComputedRef<number | undefined>
  /**
   * Thunk rather than a direct ComputedRef — this factory is called from
   * textInference.ts before `activePreset` is declared further down in the same
   * setup() function. A thunk closure is safe to construct at that point (it's
   * only invoked later, lazily, once activePreset is initialized); capturing the
   * ComputedRef by value at call time would throw ("used before initialization").
   */
  getActivePreset: () => ActivePresetKmFlags | null | undefined
  backend: Ref<string>
  backendServices: ReturnType<typeof useBackendServices>
  /** Same reasoning as getActivePreset — isLoadingSettings is a `let` declared later. */
  isLoadingSettings: () => boolean
}

export function createPhisonKmRag(deps: PhisonKmRagDeps) {
  // Phison KM RAG retrieval mode — per-preset user choice persisted in settingsPerPreset.
  // 'standard' = ordinary chunk RAG; 'phisonKm' = merged-group retrieval + KV cache reuse.
  const ragMode = ref<'standard' | 'phisonKm'>('standard')

  // Whether Phison SSD hardware is detected — controls VISIBILITY of the KM toggle.
  const phisonSsdPresent = computed(() => deps.backendServices.phisonSsdDetected)

  // True when the active model's own context ceiling can accommodate the KM floor
  // (16 384), or when the model's ceiling isn't known yet. This is what keeps the
  // "cap to model max" rule and the "floor at 16 384" rule from ever contradicting
  // each other (see enforceKmContextFloor and the contextSize watcher below) — if a
  // model's hard maximum is below 16 384, forcing the floor would be physically
  // impossible and is exactly what caused the watcher ping-pong CodeRabbit flagged.
  // Gating availability on this, instead of clamping the floor down to fit
  // (CodeRabbit's suggested fix), keeps KM's behavioral guarantee ("group + prefix
  // always fits the window") intact: it's disabled outright, with a reason shown in
  // the UI, rather than silently running in a window too small for a merged group.
  const kmContextFloorReachable = computed(
    () =>
      deps.maxContextSizeFromModel.value === undefined ||
      deps.maxContextSizeFromModel.value >= PHISON_KM_CONTEXT_FLOOR,
  )

  // Whether the Phison KM option is fully ACTIVE (controls ENABLED state):
  //   1. Preset advertises KM support (supportsPhisonKmRag)
  //   2. llamaCPP backend is selected
  //   3. ssd-offload build is the active variant
  //   4. Phison artifact is installed on disk
  //   5. The active model's context ceiling can actually reach the KM floor
  const phisonKmAvailable = computed(
    () =>
      deps.getActivePreset()?.supportsPhisonKmRag === true &&
      deps.backend.value === 'llamaCPP' &&
      deps.backendServices.llamaCppBuildVariant === 'ssd-offload' &&
      (deps.backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
        ?.llamaCppPhisonArtifactReady ??
        false) &&
      kmContextFloorReachable.value,
  )

  // KM is effective only when the user picked it AND it is available.
  const isPhisonKmRag = computed(() => ragMode.value === 'phisonKm' && phisonKmAvailable.value)

  // Whether the 16 384 context-size floor must be enforced. This is true when KM is
  // actually active, OR when the active preset is a dedicated Phison KM preset
  // (requiresPhison, which forces ragMode = 'phisonKm'). The requiresPhison branch makes
  // the floor a hard rule for the aiDAPTIV™ RAG preset regardless of transient hardware
  // detection state, so its context size can never drop below 16 384 — EXCEPT when the
  // model's own ceiling can't reach it (kmContextFloorReachable), in which case there is
  // no valid floor to enforce and the model-max clamp below takes over instead.
  const enforceKmContextFloor = computed(
    () =>
      kmContextFloorReachable.value &&
      (isPhisonKmRag.value ||
        (ragMode.value === 'phisonKm' && deps.getActivePreset()?.requiresPhison === true)),
  )

  // Stash standard-mode contextSize so switching back from Phison KM restores it.
  // Persisted by the caller (textInference.ts includes it in settingsPerPreset,
  // alongside ragMode) so it survives an app restart while KM mode is active —
  // otherwise switching back to standard after a relaunch would have nothing to
  // restore and get stuck at the KM floor.
  const stashedStandardContextSize = ref<number | null>(null)

  // True while contextSize is being written by internal logic (floor enforcement,
  // max clamp, ragMode-switch restore) rather than directly by the user (e.g. typing
  // in the settings field). The contextSize watcher below reads this to distinguish
  // "the user deliberately chose a value while in KM mode" (invalidate the stash, so
  // switching back to standard doesn't clobber their choice) from "we auto-adjusted
  // it ourselves" (leave the stash alone). Relies on that watcher using `flush:
  // 'sync'` so it observes the flag before contextSizeAdjust clears it.
  let isAutoAdjustingContextSize = false

  function contextSizeAdjust(value: number) {
    isAutoAdjustingContextSize = true
    deps.contextSize.value = value
    isAutoAdjustingContextSize = false
  }

  // When the user toggles retrieval mode, auto-adjust contextSize.
  watch(ragMode, (mode, prevMode) => {
    if (deps.isLoadingSettings()) return
    if (mode === 'phisonKm' && prevMode === 'standard') {
      if (deps.contextSize.value < PHISON_KM_CONTEXT_FLOOR) {
        stashedStandardContextSize.value = deps.contextSize.value
        contextSizeAdjust(PHISON_KM_CONTEXT_FLOOR)
      }
    } else if (mode === 'standard' && prevMode === 'phisonKm') {
      if (stashedStandardContextSize.value !== null) {
        contextSizeAdjust(stashedStandardContextSize.value)
        stashedStandardContextSize.value = null
      }
    }
  })

  // Enforce maxContextSize as hard limit and the Phison KM minimum (16 384) when KM
  // is active. Watch the bounds as well as the value so a model-ceiling drop or KM
  // becoming available re-clamps immediately (not only when the user edits the field).
  // Merged into a single clamp — kmContextFloorReachable guarantees lo <= hi whenever
  // both bounds apply, so this can never loop.
  watch(
    () =>
      [
        deps.contextSize.value,
        deps.maxContextSizeFromModel.value,
        enforceKmContextFloor.value,
      ] as const,
    ([newValue], previous) => {
      // Stay out of preset loading entirely. loadSettingsForActivePreset writes
      // contextSize BEFORE it writes ragMode, so during a load this watcher would
      // still be reading the OUTGOING preset's ragMode/floor — and, being flush:
      // 'sync', it would clamp the incoming preset's value against the wrong bounds
      // before ragMode catches up (e.g. aiDAPTIV KM → Advanced Chat would push
      // Advanced Chat's 8192 up to 16 384 and never put it back, since the ragMode
      // watcher below early-returns during loads). It would also see the incoming
      // write as a "manual edit" and wipe the stash that load is about to restore.
      // loadSettingsForActivePreset applies both bounds explicitly instead.
      if (deps.isLoadingSettings()) return
      // Cloud Mode never sends contextSize to a provider; it is the size we ask a
      // local backend to allocate later, so a remote model's window must not shrink it.
      if (deps.backend.value === 'cloud') return

      // Only a real contextSize change counts as an edit — the model ceiling and the
      // floor also re-trigger this watcher, and a re-clamp of our own is not the user
      // asking for anything.
      const prevContextSize = previous?.[0]
      const userEdited =
        prevContextSize !== undefined && newValue !== prevContextSize && !isAutoAdjustingContextSize

      // A manual edit while in KM mode means the user has taken over — the stashed
      // pre-KM value is no longer what they'd want restored on switch-back.
      if (userEdited && ragMode.value === 'phisonKm') {
        stashedStandardContextSize.value = null
      }

      // An edit is a new intent; anything else re-derives from the standing one, so a
      // ceiling that drops and rises again lands back where the user put it instead of
      // leaving the setting stuck at the smallest model ever selected.
      if (userEdited) deps.requestedContextSize.value = newValue

      const hi = deps.maxContextSizeFromModel.value
      const lo = enforceKmContextFloor.value ? PHISON_KM_CONTEXT_FLOOR : undefined
      let clamped = deps.requestedContextSize.value
      if (hi !== undefined) clamped = Math.min(clamped, hi)
      if (lo !== undefined) clamped = Math.max(clamped, lo)

      if (clamped !== newValue) {
        contextSizeAdjust(clamped)
      }
    },
    { flush: 'sync' },
  )

  return {
    ragMode,
    stashedStandardContextSize,
    phisonSsdPresent,
    kmContextFloorReachable,
    phisonKmAvailable,
    isPhisonKmRag,
    enforceKmContextFloor,
    contextSizeAdjust,
  }
}

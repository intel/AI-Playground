import { describe, it, expect, beforeEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { createPhisonKmRag, type PhisonKmRagDeps } from './phisonKmRag'

/**
 * The context-size clamp, isolated from the store that owns it.
 *
 * The subject is the relationship between the two sizes: `requestedContextSize` is
 * what was asked for, `contextSize` is what the active model can actually be given.
 * Re-deriving the second from the first — rather than repeatedly re-clamping the
 * second against itself — is what stops a small model from permanently capping every
 * model chosen after it. That regression shipped: selecting a 2048-token model once
 * left OVMS being started with `--max_prompt_len 2048` for an 8B model afterwards.
 */
describe('phisonKmRag context-size clamp', () => {
  let contextSize: ReturnType<typeof ref<number>>
  let requestedContextSize: ReturnType<typeof ref<number>>
  let modelCeiling: ReturnType<typeof ref<number | undefined>>
  let backend: ReturnType<typeof ref<string>>

  /** KM off throughout: these cases are about the model ceiling, not the KM floor. */
  function setup(initial: number) {
    contextSize = ref(initial)
    requestedContextSize = ref(initial)
    modelCeiling = ref<number | undefined>(undefined)
    backend = ref('llamaCPP')

    const deps = {
      contextSize,
      requestedContextSize,
      maxContextSizeFromModel: computed(() => modelCeiling.value),
      getActivePreset: () => ({ supportsPhisonKmRag: false, requiresPhison: false }),
      backend,
      // Only the three fields the factory reads; KM stays unavailable throughout.
      backendServices: {
        phisonSsdDetected: false,
        llamaCppBuildVariant: 'default',
        info: [],
      },
      isLoadingSettings: () => false,
    } as unknown as PhisonKmRagDeps

    return createPhisonKmRag(deps)
  }

  beforeEach(() => setup(32768))

  it('caps the allocated size at the model ceiling', async () => {
    modelCeiling.value = 2048
    await nextTick()
    expect(contextSize.value).toBe(2048)
  })

  it('leaves the requested size alone when a small model caps it', async () => {
    modelCeiling.value = 2048
    await nextTick()
    expect(requestedContextSize.value).toBe(32768)
  })

  it('restores the requested size when a larger model is selected', async () => {
    // The regression: 2048 used to become the new standing value, so the 8B model
    // that followed was still served a 2048-token window.
    modelCeiling.value = 2048
    await nextTick()
    expect(contextSize.value).toBe(2048)

    modelCeiling.value = 131072
    await nextTick()
    expect(contextSize.value).toBe(32768)
  })

  it('grows only as far as the new ceiling allows', async () => {
    modelCeiling.value = 2048
    await nextTick()
    modelCeiling.value = 8192
    await nextTick()
    expect(contextSize.value).toBe(8192)
    expect(requestedContextSize.value).toBe(32768)
  })

  it('treats a user edit as the new standing intent', async () => {
    modelCeiling.value = 131072
    await nextTick()

    contextSize.value = 4096
    await nextTick()
    expect(requestedContextSize.value).toBe(4096)

    // A bigger model must not undo a size the user chose deliberately.
    modelCeiling.value = 131072
    await nextTick()
    expect(contextSize.value).toBe(4096)
  })

  it('holds an edit made while a small model was active', async () => {
    modelCeiling.value = 2048
    await nextTick()

    contextSize.value = 1024
    await nextTick()
    expect(requestedContextSize.value).toBe(1024)

    modelCeiling.value = 131072
    await nextTick()
    expect(contextSize.value).toBe(1024)
  })

  it('leaves Cloud Mode unclamped — the size is for a local backend, not a provider', async () => {
    backend.value = 'cloud'
    modelCeiling.value = 2048
    await nextTick()
    expect(contextSize.value).toBe(32768)
  })
})

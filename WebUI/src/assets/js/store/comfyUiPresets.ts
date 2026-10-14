import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import type { Preset } from './presets'
import { useImageGenerationPresets } from './imageGenerationPresets'
import { useI18N } from './i18n'
import { useActivities } from './activities'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { parseCustomNodeSpec } from '@/lib/customNodeRepoId'
import { getComfyAuthToken, invalidateComfyAuthToken } from '@/lib/loopbackAuth'

/**
 * Wraps fetch() with the ComfyUI loopback bearer token. The bundled
 * `aipg-auth` ComfyUI custom_node requires this header on every non-/queue
 * request; without it any other local process / web page could reach
 * ComfyUI's API on 127.0.0.1.
 */
async function comfyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let token = await getComfyAuthToken()
  const buildInit = (t: string): RequestInit => {
    const headers = new Headers(init?.headers ?? {})
    if (t) headers.set('Authorization', `Bearer ${t}`)
    return { ...(init ?? {}), headers }
  }
  let response = await fetch(input, buildInit(token))
  if (response.status === 401) {
    invalidateComfyAuthToken()
    token = await getComfyAuthToken()
    if (token) {
      response = await fetch(input, buildInit(token))
    }
  }
  return response
}

// ── Explicit generation run types ──────────────────────────────────────────────
//
// The engine that consumed generation-run types moved into the main-process
// artifact runner (electron/artifact/runner.ts, architecture-target §4.1 step 5);
// params stay because runArtifact.ts still speaks them when describing a resolved run.

/** Fully resolved sampling values for one run; the seed is the batch base. */
export type ComfyGenerationParams = {
  prompt: string
  negativePrompt: string
  seed: number
  inferenceSteps: number
  width: number
  height: number
  batchSize: number
}

export const useComfyUiPresets = defineStore(
  'comfyUiPresets',
  () => {
    const imageGeneration = useImageGenerationPresets()
    const activities = useActivities()
    const i18nState = useI18N().state

    // Bridge the generation FSM (imageGeneration.currentState) to a single activity
    // so the central activity sink reflects image-gen progress. For desktop runs the
    // activity is imageGen-scoped; for tool calls it nests under the chat tool
    // activity (generationParentActivityId) so the chat status line shows progress.
    let generationActivityId: string | null = null
    const GENERATION_ACTIVE_STATES = [
      'start_backend',
      'install_workflow_components',
      'load_workflow_components',
      'load_model',
      'load_model_components',
      'generating',
    ]
    function generationStateLabel(state: string): string {
      switch (state) {
        case 'start_backend':
          return i18nState.COM_STARTING_BACKEND
        case 'load_model':
          return i18nState.COM_LOADING_MODEL
        case 'load_model_components':
          return i18nState.COM_LOADING_MODEL_COMPONENTS
        case 'install_workflow_components':
          return i18nState.COM_INSTALL_WORKFLOW_COMPONENTS
        case 'load_workflow_components':
          return i18nState.COM_LOADING_WORKFLOW_COMPONENTS
        case 'generating':
          return imageGeneration.stepText || i18nState.COM_GENERATING
        default:
          return i18nState.COM_GENERATING
      }
    }
    watch(
      () =>
        [
          imageGeneration.currentState,
          imageGeneration.stepText,
          imageGeneration.processing,
        ] as const,
      ([state, _stepText, processing]) => {
        const isActive = processing || GENERATION_ACTIVE_STATES.includes(state)
        if (isActive) {
          const label = generationStateLabel(state)
          if (!generationActivityId) {
            generationActivityId = activities.begin({
              category: 'generation',
              label,
              scope: { kind: 'imageGen' },
              parentId: imageGeneration.generationParentActivityId ?? undefined,
            })
          } else {
            activities.update(generationActivityId, { label })
          }
        } else if (generationActivityId) {
          const endState =
            state === 'error' ? 'failed' : state === 'image_out' ? 'done' : 'cancelled'
          if (generationActivityId) {
            activities.end(generationActivityId, endState)
            generationActivityId = null
          }
        }
      },
    )

    // Stall protection lives in the artifact runner (runArtifact.ts), which
    // every driver goes through: one re-arming idle watchdog covering the
    // backend boot / install / model-load phases as well as execution. This
    // store no longer arms its own execution-only timer.
    const comfyBaseUrl = computed(() => comfyUiState.value?.baseUrl)

    const backendServices = useBackendServices()
    const comfyUiState = computed(() => {
      return backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
    })

    async function checkPresetRequirements(preset: Preset | null): Promise<{
      hasMissingRequirements: boolean
      missingCustomNodes: string[]
      missingPythonPackages: string[]
    }> {
      if (!preset || preset.type !== 'comfy') {
        return {
          hasMissingRequirements: false,
          missingCustomNodes: [],
          missingPythonPackages: [],
        }
      }

      const customNodes = preset.requiredCustomNodes ?? []
      const pythonPackages = preset.requiredPythonPackages ?? []

      console.info('Checking preset requirements', {
        customNodes,
        pythonPackages,
      })

      const nodeChecks = await Promise.all(
        customNodes.map(async (node) => {
          const isInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
            extractCustomNodeInfo(node),
          )
          return { node, isInstalled }
        }),
      )
      const missingCustomNodes = nodeChecks
        .filter((check) => !check.isInstalled)
        .map((check) => check.node)

      const packageChecks = await Promise.all(
        pythonPackages.map(async (pkg) => {
          const isInstalled = await window.electronAPI.comfyui.isPackageInstalled(pkg)
          return { package: pkg, isInstalled }
        }),
      )
      const missingPythonPackages = packageChecks
        .filter((check) => !check.isInstalled)
        .map((check) => check.package)

      const hasMissingRequirements =
        missingCustomNodes.length > 0 || missingPythonPackages.length > 0

      return {
        hasMissingRequirements,
        missingCustomNodes,
        missingPythonPackages,
      }
    }

    function extractCustomNodeInfo(
      workflowNodeInfoString: string,
    ): ComfyUICustomNodesRequestParameters {
      const id = parseCustomNodeSpec(workflowNodeInfoString)
      if (!id.gitRef) {
        console.warn(`No gitRef provided in ${workflowNodeInfoString}.`)
      }
      return id
    }

    async function freeMemoryAndUnloadModels() {
      await comfyFetch(`${comfyBaseUrl.value}/free`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ free_memory: true, unload_models: true }),
      })
    }

    return {
      free: freeMemoryAndUnloadModels,
      checkPresetRequirements,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComfyUiPresets, import.meta.hot))
}

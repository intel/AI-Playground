import { defineStore, acceptHMRUpdate } from 'pinia'
import { WebSocket } from 'partysocket'
import { demoAwareStorage } from '../demoAwareStorage'
import { ComfyUIApiWorkflow, type Preset } from './presets'
import { useDeveloperSettings } from './developerSettings'
import {
  useImageGenerationPresets,
  modelNameForComfyApi,
  OPTIONAL_MODEL_NONE,
  type MediaItem,
} from './imageGenerationPresets'
import { useI18N } from './i18n'
import { useErrors } from './errors'
import { useActivities } from './activities'
import { createAppError } from '../errors/appError'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePromptStore } from './promptArea'
import { z } from 'zod'
import { imageUrlToDataUri, isImageUrl, mediaUrl } from '@/lib/utils'
import { getComfyAuthToken, invalidateComfyAuthToken } from '@/lib/loopbackAuth'
import {
  findKeysByClassType,
  findKeysByTitle,
  modifySettingInWorkflow,
} from './comfyUiWorkflowHelpers'

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

const WEBSOCKET_OPEN = 1

const ComfyMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
  }),
  z.object({
    type: z.literal('execution_start'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_success'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_error'),
    data: z
      .object({
        exception_message: z.string().optional(),
        exception_type: z.string().optional(),
        node_id: z.union([z.string(), z.number()]).optional(),
        node_type: z.string().optional(),
        traceback: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('execution_interrupted'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_cached'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('progress'),
    data: z
      .object({
        value: z.number(),
        max: z.number(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('executing'),
    data: z
      .object({
        node: z.string().nullable().optional(),
        display_node: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('executed'),
    data: z
      .object({
        output: z.union([
          z.object({
            images: z.array(
              z.object({
                filename: z.string(),
                subfolder: z.string(),
                type: z.string(),
              }),
            ),
            animated: z.array(z.boolean()).optional(),
          }),
          z.object({
            gifs: z.array(
              z.object({
                filename: z.string(),
                workflow: z.string(),
                type: z.string(),
                subfolder: z.string(),
                format: z.string(),
              }),
            ),
          }),
          z.object({
            '3d': z.array(
              z.object({
                filename: z.string(),
                subfolder: z.string(),
                type: z.string(),
              }),
            ),
          }),
        ]),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('progress_state'),
    data: z.object({}).passthrough(),
  }),
])

type ComfyExecutionErrorData = {
  exception_message?: string
  exception_type?: string
  node_id?: string | number
  node_type?: string
  traceback?: string[]
}

// ComfyUI reports node failures with a full Python exception (often a multi-KB
// state_dict / size-mismatch dump). That is useless and overwhelming as a
// user-facing string, so we map the common, recognizable failures to a short,
// actionable sentence and keep the raw detail for the logs/debug panel only.
function summarizeComfyExecutionError(data: ComfyExecutionErrorData): string {
  const raw = (data.exception_message ?? '').trim()
  const lower = raw.toLowerCase()
  const type = (data.exception_type ?? '').toLowerCase()

  if (
    lower.includes('size mismatch') ||
    lower.includes('error(s) in loading state_dict') ||
    lower.includes('load_state_dict')
  ) {
    return "The selected model doesn't match this workflow (mismatched weights while loading). Pick a model that fits the preset, or choose a different preset."
  }
  if (
    lower.includes('out of memory') ||
    lower.includes('outofmemory') ||
    lower.includes('failed to allocate') ||
    (lower.includes('alloc') && lower.includes('memory'))
  ) {
    return 'Ran out of memory while generating. Try a smaller resolution or batch size.'
  }
  if (
    type.includes('filenotfound') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('does not exist')
  ) {
    return 'A required model or file could not be found. Make sure the needed models are downloaded.'
  }

  // Fallback: first meaningful line of the exception, trimmed to a sane length.
  const firstLine =
    raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const concise = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  const prefix = data.node_type ? `${data.node_type}: ` : ''
  return concise ? `${prefix}${concise}` : 'The workflow failed during execution.'
}

const OVMS_IMAGE_CLASS_TYPES = ['OpenAICompatibleImageGeneration', 'OpenAICompatibleImageEdit']

function workflowUsesOvmsImage(workflow: ComfyUIApiWorkflow): boolean {
  return OVMS_IMAGE_CLASS_TYPES.some((ct) => findKeysByClassType(workflow, ct).length > 0)
}

function injectOvmsImageUrl(workflow: ComfyUIApiWorkflow, url: string): void {
  for (const classType of OVMS_IMAGE_CLASS_TYPES) {
    for (const key of findKeysByClassType(workflow, classType)) {
      const inputs = workflow[key]?.inputs
      if (!inputs || typeof inputs !== 'object') continue
      if ('base_url' in inputs) {
        inputs['base_url'] = url
      }
      // OVMS registers the served graph under the slash-flattened repo id
      // (see `--source_model` in openVINOBackendService.ts), so the model
      // sent in the OpenAI-compatible request must use the same form.
      if ('model' in inputs && typeof inputs['model'] === 'string') {
        inputs['model'] = inputs['model'].split('/').join('---')
      }
    }
  }
}

/** ComfyUI node input names that hold model/file paths; separator is OS-dependent (see main.ts preset handling). */
const COMFY_MODEL_PATH_INPUTS = new Set([
  'ckpt_name',
  'lora_name',
  'text_encoder',
  'vae_name',
  'unet_name',
  'clip_name',
  'model_name',
  'control_net_name',
])

function normalizeModelPathsInWorkflow(
  workflow: ComfyUIApiWorkflow,
  platform: NodeJS.Platform,
): void {
  for (const node of Object.values(workflow)) {
    const inputs = (node as { inputs?: Record<string, unknown> }).inputs
    if (!inputs) continue
    for (const [inputName, value] of Object.entries(inputs)) {
      if (COMFY_MODEL_PATH_INPUTS.has(inputName) && typeof value === 'string') {
        inputs[inputName] = modelNameForComfyApi(value, platform)
      }
    }
  }
}

/**
 * Bypass a node by rewiring its outputs to its upstream and removing the node.
 * Supported: LoraLoader (output 0 = model from input "model", output 1 = clip from input "clip").
 */
function bypassNode(workflow: ComfyUIApiWorkflow, nodeId: string): void {
  const node = workflow[nodeId] as
    | { class_type?: string; inputs?: Record<string, unknown> }
    | undefined
  if (!node?.inputs) return
  const classType = node.class_type
  let rewire: [number, [string, number]][]
  if (classType === 'LoraLoader') {
    const model = node.inputs.model as [string, number] | undefined
    const clip = node.inputs.clip as [string, number] | undefined
    if (!model || !clip) return
    rewire = [
      [0, model],
      [1, clip],
    ]
  } else {
    return
  }
  for (const entry of Object.values(workflow)) {
    const inputs = (entry as { inputs?: Record<string, unknown> }).inputs
    if (!inputs) continue
    for (const key of Object.keys(inputs)) {
      const v = inputs[key]
      if (
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === 'string' &&
        typeof v[1] === 'number'
      ) {
        if (v[0] === nodeId) {
          const slot = v[1]
          const upstream = rewire.find(([s]) => s === slot)?.[1]
          if (upstream) inputs[key] = upstream
        }
      }
    }
  }
  delete workflow[nodeId]
}

/** Rewire and remove optional model nodes whose value is None (e.g. LoRA bypass). */
function bypassOptionalModelNodes(workflow: ComfyUIApiWorkflow): void {
  const imageGeneration = useImageGenerationPresets()
  for (const input of imageGeneration.comfyInputs) {
    if (
      input.type !== 'model' ||
      input.optional !== true ||
      input.current.value !== OPTIONAL_MODEL_NONE
    ) {
      continue
    }
    const keys = findKeysByTitle(workflow, input.nodeTitle)
    for (const key of keys) {
      bypassNode(workflow, key)
    }
  }
}

import type { InstallationPhase } from './dialogs'

export type InstallationProgressCallback = (progress: {
  phase: InstallationPhase
  currentItem?: string
  completedItems: number
  totalItems: number
  statusMessage: string
}) => void

export const useComfyUiPresets = defineStore(
  'comfyUiPresets',
  () => {
    const imageGeneration = useImageGenerationPresets()
    const errors = useErrors()
    const activities = useActivities()
    const i18nState = useI18N().state
    const comfyPort = computed(() => comfyUiState.value?.port)

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
          activities.end(generationActivityId, endState)
          generationActivityId = null
        }
      },
    )

    // Watchdog: if a generation neither completes nor errors within this window,
    // we assume the backend is wedged and fail the in-flight items so the UI and
    // any LLM tool call waiting on completion are released instead of hanging.
    const GENERATION_WATCHDOG_MS = 10 * 60 * 1000
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    // Set while we intentionally restart ComfyUI mid-generate (to install custom
    // nodes), so crash detection doesn't mistake the planned bounce for a crash.
    let backendRestarting = false

    function clearWatchdog() {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
      }
    }

    function armWatchdog() {
      clearWatchdog()
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        if (!imageGeneration.processing) return
        const promptStore = usePromptStore()
        promptStore.promptSubmitted = false
        imageGeneration.failGeneration('Image generation timed out.')
        errors.report(
          createAppError({
            category: 'generation',
            code: 'generation/timeout',
            userMessage:
              'Image generation timed out. The ComfyUI backend may be stuck — try again or restart it.',
            surface: 'toast',
          }),
        )
      }, GENERATION_WATCHDOG_MS)
    }
    const comfyBaseUrl = computed(() => comfyUiState.value?.baseUrl)

    const websocket = ref<WebSocket | null>(null)
    const clientId = '12345'
    const loaderNodes = ref<string[]>([])
    let generateIdx: number = 0
    let queuedImages: MediaItem[] = []

    const pendingGenerationRequest = ref<{
      imageIds: string[]
      mode: WorkflowModeType
      sourceImage?: string
    } | null>(null)
    const pendingRetryTimer = ref<ReturnType<typeof setTimeout> | null>(null)

    const backendServices = useBackendServices()
    const comfyUiState = computed(() => {
      return backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
    })

    async function installCustomNodesForActivePresetFully() {
      const requirements = await checkPresetRequirements()
      if (!requirements.hasMissingRequirements) return
      console.info('restarting comfyUI to finalize installation of required custom nodes')
      // Suspend crash detection: this stop/start is intentional, not a crash.
      backendRestarting = true
      try {
        await backendServices.stopService('comfyui-backend')
        await triggerInstallPythonPackagesForActivePreset() // Backend already stopped above
        await installCustomNodesForActivePreset()
        const startingResult = await backendServices.startService('comfyui-backend')
        if (startingResult !== 'running') {
          throw new Error('Failed to restart comfyUI. Required Nodes are not active.')
        }
        console.info('restart complete')
      } finally {
        backendRestarting = false
      }
    }

    async function checkPresetRequirements(): Promise<{
      hasMissingRequirements: boolean
      missingCustomNodes: string[]
      missingPythonPackages: string[]
    }> {
      const preset = imageGeneration.activePreset
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
      const repoInfoWithPotentialGitRefSplitted = workflowNodeInfoString.replace(' ', '').split('@')
      if (
        repoInfoWithPotentialGitRefSplitted.length > 2 ||
        repoInfoWithPotentialGitRefSplitted.length < 1
      ) {
        console.error(`Could not extract comfyUI node description from ${workflowNodeInfoString}`)
        throw new Error('Could not extract comfyUI node description from ${workflowNodeInfoString}')
      }
      const [repoInfoString, gitRef] = repoInfoWithPotentialGitRefSplitted
      if (!gitRef) {
        console.warn(`No gitRef provided in ${workflowNodeInfoString}.`)
      }
      const repoInfoSplitted = repoInfoString.replace(' ', '').split('/')
      if (repoInfoSplitted.length !== 2) {
        console.error(`Could not extract comfyUI node description from ${workflowNodeInfoString}`)
        throw new Error('Could not extract comfyUI node description from ${workflowNodeInfoString}')
      }
      const [username, repoName] = repoInfoSplitted
      return { username: username, repoName: repoName, gitRef: gitRef }
    }

    async function installCustomNodesForActivePreset(
      callback?: InstallationProgressCallback,
    ): Promise<boolean> {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') return false

      const requiredCustomNodes = preset.requiredCustomNodes ?? []

      const nodesToInstall: ComfyUICustomNodesRequestParameters[] = []
      for (const node of requiredCustomNodes) {
        const isInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
          extractCustomNodeInfo(node),
        )
        if (!isInstalled) {
          nodesToInstall.push(extractCustomNodeInfo(node))
        }
      }

      if (nodesToInstall.length === 0) return false

      try {
        for (let i = 0; i < nodesToInstall.length; i++) {
          const node = nodesToInstall[i]
          const nodeName = `${node.username}/${node.repoName}`
          callback?.({
            phase: 'installing_custom_nodes',
            currentItem: nodeName,
            completedItems: i,
            totalItems: nodesToInstall.length,
            statusMessage: `Installing custom node: ${nodeName}`,
          })
          const result = await window.electronAPI.comfyui.downloadCustomNode(node)
          if (!result) {
            throw new Error(`Failed to install custom node: ${nodeName}`)
          }
          callback?.({
            phase: 'installing_custom_nodes',
            currentItem: nodeName,
            completedItems: i + 1,
            totalItems: nodesToInstall.length,
            statusMessage: `Installed custom node: ${nodeName}`,
          })
        }
        return true
      } catch (_error) {
        const failedNodeNames = nodesToInstall.map((n) => `${n.username}/${n.repoName}`).join(', ')
        throw new Error(`Failed to install required comfyUI custom nodes: ${failedNodeNames}`)
      }
    }

    async function triggerInstallPythonPackagesForActivePreset(
      callback?: InstallationProgressCallback,
    ) {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') return

      const toBeInstalledPackages = preset.requiredPythonPackages ?? []
      console.info('Installing python packages', { toBeInstalledPackages })

      if (toBeInstalledPackages.length === 0) return

      // Note: Backend should already be stopped by installMissingRequirements if needed

      try {
        for (let i = 0; i < toBeInstalledPackages.length; i++) {
          const pkg = toBeInstalledPackages[i]
          callback?.({
            phase: 'installing_python_packages',
            currentItem: pkg,
            completedItems: i,
            totalItems: toBeInstalledPackages.length,
            statusMessage: `Installing Python package: ${pkg}`,
          })
          await window.electronAPI.comfyui.installPypiPackage(pkg)
          callback?.({
            phase: 'installing_python_packages',
            currentItem: pkg,
            completedItems: i + 1,
            totalItems: toBeInstalledPackages.length,
            statusMessage: `Installed Python package: ${pkg}`,
          })
        }
        console.info('python package installation completed')
      } catch (error) {
        throw new Error(`Failed to install Python packages: ${error}`)
      }
    }

    /**
     * Installs missing requirements for the active preset (custom nodes and Python packages)
     * This will restart the ComfyUI backend if needed
     */
    async function installMissingRequirements(
      callback?: InstallationProgressCallback,
    ): Promise<void> {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') {
        throw new Error('No ComfyUI preset is active')
      }

      // Check what's missing
      const requirements = await checkPresetRequirements()

      if (!requirements.hasMissingRequirements) {
        console.info('No missing requirements to install')
        return
      }

      // Stop backend before installation
      const wasRunning =
        backendServices.info.find((s) => s.serviceName === 'comfyui-backend')?.status === 'running'

      if (wasRunning) {
        callback?.({
          phase: 'stopping_backend',
          completedItems: 0,
          totalItems: 0,
          statusMessage: 'Stopping ComfyUI backend...',
        })
        await backendServices.stopService('comfyui-backend')
        callback?.({
          phase: 'stopping_backend',
          completedItems: 1,
          totalItems: 1,
          statusMessage: 'ComfyUI backend stopped',
        })
      }

      try {
        // Install Python packages first (if any)
        if (requirements.missingPythonPackages.length > 0) {
          console.info('Installing Python packages:', requirements.missingPythonPackages)
          await triggerInstallPythonPackagesForActivePreset(callback)
        }

        // Install custom nodes (if any)
        if (requirements.missingCustomNodes.length > 0) {
          console.info('Installing custom nodes:', requirements.missingCustomNodes)
          await installCustomNodesForActivePreset(callback)
        }

        // Restart backend if it was running
        if (wasRunning) {
          callback?.({
            phase: 'starting_backend',
            completedItems: 0,
            totalItems: 0,
            statusMessage: 'Starting ComfyUI backend...',
          })
          const startResult = await backendServices.startService('comfyui-backend')
          if (startResult !== 'running') {
            throw new Error('Failed to restart ComfyUI backend after installation')
          }
          callback?.({
            phase: 'starting_backend',
            completedItems: 1,
            totalItems: 1,
            statusMessage: 'ComfyUI backend started',
          })
        }
      } catch (error) {
        console.error('Error installing missing requirements:', error)
        callback?.({
          phase: 'error',
          completedItems: 0,
          totalItems: 0,
          statusMessage: `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        throw error
      }
    }

    async function connectToComfyUi() {
      if (comfyUiState.value?.status !== 'running') {
        console.warn('ComfyUI backend not running, cannot start websocket')
        return
      }

      // Browsers cannot set custom headers on WebSocket upgrades, so the
      // bundled aipg-auth middleware accepts the loopback token via query
      // string for the /ws endpoint.
      //
      // Force-refresh the token: a rejected WS upgrade just shows up as a
      // close event with no auth-specific status code, so we can't detect
      // and retry like we do for HTTP 401. Pulling fresh from the Electron
      // main process on every connect attempt is cheap (single IPC) and
      // ensures we never connect with a token from a previous ComfyUI spawn
      // (each spawn regenerates AIPG_LOOPBACK_TOKEN).
      const wsToken = await getComfyAuthToken(true)
      const comfyWsUrl =
        `ws://localhost:${comfyPort.value}/ws?clientId=${clientId}` +
        (wsToken ? `&token=${encodeURIComponent(wsToken)}` : '')

      if (websocket.value) {
        const state = websocket.value.readyState
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
          console.info('ComfyUI websocket already connected or connecting, reusing')
          return
        }
        console.info('Closing stale websocket connection before creating new one')
        try {
          websocket.value.close()
        } catch (e) {
          console.warn('Error closing stale websocket:', e)
        }
        websocket.value = null
      }

      console.info('Connecting to ComfyUI', { comfyWsUrl })
      websocket.value = new WebSocket(comfyWsUrl)
      websocket.value.binaryType = 'arraybuffer'

      websocket.value.addEventListener('open', () => {
        console.info('ComfyUI websocket connection established')
      })

      websocket.value.addEventListener('close', (event) => {
        console.info('ComfyUI websocket connection closed', {
          code: event.code,
          reason: event.reason,
        })
        // Drop the cached token in case the close was caused by an auth
        // rejection on the upgrade (e.g. ComfyUI restarted with a fresh
        // AIPG_LOOPBACK_TOKEN). The next connect attempt will pull a fresh
        // token from the Electron main process. This is also a no-op on a
        // clean close, since the next force-refresh in connectToComfyUi
        // will overwrite it anyway.
        invalidateComfyAuthToken()
      })

      websocket.value.addEventListener('error', (error) => {
        console.error('ComfyUI websocket error:', error)
      })

      websocket.value.addEventListener('message', (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data)
            const eventType = view.getUint32(0)
            const buffer = event.data.slice(4)
            switch (eventType) {
              case 1:
                // Always update the image state to 'generating' for progress display
                const currentImage = queuedImages[generateIdx]
                if (currentImage && currentImage.state !== 'generating') {
                  imageGeneration.updateImage({
                    ...currentImage,
                    state: 'generating',
                  })
                }

                // Skip preview image if showPreview is disabled
                if (!imageGeneration.showPreview) break

                const view2 = new DataView(event.data)
                const imageType = view2.getUint32(0)
                let imageMime
                switch (imageType) {
                  case 1:
                  default:
                    imageMime = 'image/jpeg'
                    break
                  case 2:
                    imageMime = 'image/png'
                }
                const imageBlob = new Blob([buffer.slice(4)], {
                  type: imageMime,
                })
                const imageUrl = URL.createObjectURL(imageBlob)
                if (imageBlob) {
                  const newImage: MediaItem = {
                    ...queuedImages[generateIdx],
                    state: 'generating',
                    type: 'image',
                    imageUrl,
                  }
                  imageGeneration.updateImage(newImage)
                }
                break
              default:
                throw new Error(`Unknown binary websocket message of type ${eventType}`)
            }
          } else {
            const msg = ComfyMessageSchema.parse(JSON.parse(event.data))
            switch (msg.type) {
              case 'status':
                break
              case 'progress':
                imageGeneration.currentState = 'generating'
                imageGeneration.stepText = `${i18nState.COM_GENERATING} ${msg.data.value}/${msg.data.max}`
                if (generationActivityId && msg.data.max > 0) {
                  activities.update(generationActivityId, {
                    label: imageGeneration.stepText,
                    progress: msg.data.value / msg.data.max,
                  })
                }
                console.log('progress', { data: msg.data })
                break
              case 'executing':
                const executingNode = msg.data.node
                console.log('executing', {
                  detail: msg.data.display_node || executingNode,
                  node: executingNode,
                  isLoaderNode: loaderNodes.value.includes(executingNode ?? ''),
                })
                // Transition state based on which node is executing
                if (executingNode && loaderNodes.value.includes(executingNode)) {
                  imageGeneration.currentState = 'load_model'
                } else if (executingNode === null) {
                  // Node is null when execution starts/ends - keep current state or transition to generating
                  if (imageGeneration.currentState === 'load_workflow_components') {
                    imageGeneration.currentState = 'generating'
                  }
                } else {
                  // Regular node execution - transition to generating
                  imageGeneration.currentState = 'generating'
                }
                break
              case 'executed':
                const output = msg.data.output
                const createdAt = Date.now()
                if ('images' in output) {
                  const imageIndex = output.images.findIndex((i) => i.type === 'output')
                  const image = output.images[imageIndex]
                  if (image) {
                    let newItem: MediaItem
                    if (output?.animated?.[imageIndex]) {
                      const videoUrl = mediaUrl(
                        image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename,
                      )
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        type: 'video',
                        videoUrl,
                        createdAt,
                      }
                    } else {
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        type: 'image',
                        imageUrl: mediaUrl(
                          image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename,
                        ),
                        createdAt,
                      }
                    }
                    imageGeneration.updateImage(newItem)
                    generateIdx++
                    // Update state when image is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                if ('gifs' in output) {
                  const video = output.gifs.find((i) => i.type === 'output')
                  if (video) {
                    const videoUrl = mediaUrl(
                      video.subfolder ? `${video.subfolder}/${video.filename}` : video.filename,
                    )
                    const thumbnailUrl = mediaUrl(
                      video.subfolder ? `${video.subfolder}/${video.workflow}` : video.workflow,
                    )
                    const newImage: MediaItem = {
                      ...queuedImages[generateIdx],
                      state: 'done',
                      type: 'video',
                      videoUrl,
                      thumbnailUrl,
                      createdAt,
                    }
                    imageGeneration.updateImage(newImage)
                    generateIdx++
                    // Update state when video is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                if ('3d' in output) {
                  const model3d = output['3d'].find((i) => i.type === 'output')
                  if (model3d) {
                    const model3dUrl = mediaUrl(
                      model3d.subfolder
                        ? `${model3d.subfolder}/${model3d.filename}`
                        : model3d.filename,
                    )
                    const newImage: MediaItem = {
                      ...queuedImages[generateIdx],
                      state: 'done',
                      type: 'model3d',
                      model3dUrl,
                      createdAt,
                    }
                    imageGeneration.updateImage(newImage)
                    generateIdx++
                    // Update state when 3D model is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                console.log('executed', { detail: msg.data })
                break
              case 'execution_start': {
                // Ignore stray starts for batch entries we already failed/cancelled,
                // so the UI doesn't bounce back into 'processing' with nothing in flight.
                const hasInFlight = imageGeneration.generatedImages.some(
                  (item) => item.state === 'queued' || item.state === 'generating',
                )
                if (!hasInFlight) {
                  console.log('execution_start ignored (no in-flight items)', { detail: msg.data })
                  break
                }
                imageGeneration.processing = true
                imageGeneration.currentState = 'load_workflow_components'
                armWatchdog()
                console.log('execution_start', { detail: msg.data })
                break
              }
              case 'execution_success':
                imageGeneration.processing = false
                clearWatchdog()
                console.log('execution_success', { detail: msg.data })
                break
              case 'execution_error': {
                clearWatchdog()
                const promptStore = usePromptStore()
                promptStore.promptSubmitted = false
                const data = msg.data as ComfyExecutionErrorData
                // Short, actionable message for the failed panel + toast; the raw
                // exception/traceback is kept only in technicalMessage (console + debug).
                const userMessage = summarizeComfyExecutionError(data)
                const technicalMessage =
                  [
                    data.exception_type,
                    data.node_type ? `node: ${data.node_type} (${data.node_id ?? '?'})` : null,
                    data.exception_message,
                    Array.isArray(data.traceback) ? data.traceback.join('') : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || JSON.stringify(msg.data)
                // Move in-flight items to a terminal 'failed' state (no more stuck
                // spinners) and surface a single toast via the sink.
                imageGeneration.failGeneration(userMessage)
                errors.report(
                  createAppError({
                    category: 'generation',
                    code: 'generation/execution-error',
                    userMessage,
                    technicalMessage,
                    surface: 'toast',
                    context: { serviceName: 'comfyui-backend' },
                  }),
                )
                break
              }
              case 'execution_interrupted':
                clearWatchdog()
                imageGeneration.processing = false
                imageGeneration.currentState = 'no_start'
                break
              case 'execution_cached':
                break
              case 'progress_state':
                break
            }
          }
        } catch (error) {
          console.warn('Unhandled message:', event.data, error)
        }
      })
    }

    watchEffect(() => {
      const isRunning = comfyPort.value != null && comfyUiState.value?.status === 'running'

      if (isRunning) {
        connectToComfyUi()

        if (pendingGenerationRequest.value) {
          console.info('Backend is now running, auto-retrying pending generation')
          const pending = pendingGenerationRequest.value

          if (pendingRetryTimer.value !== null) {
            clearTimeout(pendingRetryTimer.value)
            pendingRetryTimer.value = null
          }

          const attemptRetry = () => {
            pendingRetryTimer.value = setTimeout(() => {
              pendingRetryTimer.value = null
              if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
                console.info('Websocket not yet open, re-scheduling pending generation retry')
                attemptRetry()
                return
              }
              pendingGenerationRequest.value = null
              generate(pending.imageIds, pending.mode, pending.sourceImage, true)
            }, 500)
          }
          attemptRetry()
        }
      } else {
        if (pendingRetryTimer.value !== null) {
          clearTimeout(pendingRetryTimer.value)
          pendingRetryTimer.value = null
        }
        if (websocket.value) {
          console.info('Backend is not running, closing websocket connection')
          try {
            websocket.value.close()
          } catch (e) {
            console.warn('Error closing websocket:', e)
          }
          websocket.value = null
        }
      }
    })

    // Crash detection: if the backend leaves 'running' while a generation is in
    // flight (and we didn't intentionally restart it for a node install), the
    // process has died/stopped underneath us. Fail the in-flight items instead of
    // letting the UI sit on a stale 'running' world with a frozen spinner.
    watch(
      () => comfyUiState.value?.status,
      (status, previousStatus) => {
        if (previousStatus === 'running' && status !== 'running') {
          if (backendRestarting) return
          if (!imageGeneration.processing && imageGeneration.currentState === 'no_start') return
          clearWatchdog()
          const promptStore = usePromptStore()
          promptStore.promptSubmitted = false
          imageGeneration.failGeneration('The ComfyUI backend stopped unexpectedly.')
          errors.report(
            createAppError({
              category: 'generation',
              code: 'generation/backend-stopped',
              userMessage:
                'The ComfyUI backend stopped unexpectedly during generation. Please restart it and try again.',
              surface: 'toast',
              context: { serviceName: 'comfyui-backend' },
            }),
          )
        }
      },
    )

    function dataURItoBlob(dataURI: string) {
      const bytes =
        dataURI.split(',')[0].indexOf('base64') >= 0
          ? atob(dataURI.split(',')[1])
          : unescape(dataURI.split(',')[1])
      const mimeType = dataURI.split(',')[0].split(':')[1].split(';')[0]

      const intArray = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) {
        intArray[i] = bytes.charCodeAt(i)
      }

      return new Blob([intArray], { type: mimeType })
    }

    function validateRequiredImageInputs(): string[] {
      const missingInputs: string[] = []

      for (const input of imageGeneration.comfyInputs) {
        // Skip optional image inputs - they will get black pixel injected
        if (input.optional === true) {
          continue
        }

        // Check if this is a required image input
        const isImageType =
          input.type === 'image' || input.type === 'inpaintMask' || input.type === 'outpaintCanvas'
        const isDisplayed = input.displayed !== false // defaults to true
        const isModifiable = input.modifiable !== false // defaults to true
        const hasNoDefault = input.defaultValue === '' || input.defaultValue === undefined

        if (isImageType && isDisplayed && isModifiable && hasNoDefault) {
          const value = input.current.value
          const isEmpty = value === '' || value === undefined || value === null
          const isString = typeof value === 'string'
          const isValid = isString && value !== '' && isImageUrl(value)

          if (isEmpty || !isValid) {
            missingInputs.push(input.label)
          }
        }
      }

      return missingInputs
    }

    async function modifyDynamicSettingsInWorkflow(
      mutableWorkflow: ComfyUIApiWorkflow,
      platform: NodeJS.Platform,
    ) {
      for (const input of imageGeneration.comfyInputs) {
        const keys = findKeysByTitle(mutableWorkflow, input.nodeTitle)
        if (keys.length === 0) {
          continue
        }
        if (
          input.type === 'number' ||
          input.type === 'string' ||
          input.type === 'boolean' ||
          input.type === 'stringList'
        ) {
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = input.current.value
          }
        }
        if (input.type === 'model') {
          if (input.current.value === OPTIONAL_MODEL_NONE) {
            // Node will be bypassed by bypassOptionalModelNodes; do not set value
            continue
          }
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            const value =
              typeof input.current.value === 'string'
                ? modelNameForComfyApi(input.current.value, platform)
                : input.current.value
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = value
          }
        }
        if (
          input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas'
        ) {
          const rawValue = input.current.value
          const isEmpty = typeof rawValue !== 'string' || rawValue === '' || !isImageUrl(rawValue)
          const isOptional = input.optional === true

          let imageDataUri: string
          if (isEmpty && isOptional && input.type === 'image') {
            imageDataUri =
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
          } else if (typeof rawValue === 'string' && rawValue !== '') {
            imageDataUri = rawValue.startsWith('aipg-media://')
              ? await imageUrlToDataUri(rawValue)
              : rawValue
          } else {
            continue
          }

          const uploadImageHash = Array.from(
            new Uint8Array(
              await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageDataUri)),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          // PNG for alpha (inpaint / outpaint composites); else follow data URI
          let uploadImageExtension = 'png'
          if (input.type === 'image') {
            const match = imageDataUri.match(/data:image\/(png|jpeg|webp);base64,/)
            uploadImageExtension = match?.[1] || 'png'
          }
          const uploadImageName = `${uploadImageHash}.${uploadImageExtension}`
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadImageName
          }
          const data = new FormData()
          data.append('image', dataURItoBlob(imageDataUri), uploadImageName)
          await comfyFetch(`${comfyBaseUrl.value}/upload/image`, {
            method: 'POST',
            body: data,
          })
        }
        if (input.type === 'video') {
          if (typeof input.current.value !== 'string') continue
          const uploadVideoHash = Array.from(
            new Uint8Array(
              await window.crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(input.current.value),
              ),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          const uploadVideoExtension = input.current.value.match(
            /data:video\/(mp4|h264|h265);base64,/,
          )?.[1]
          const uploadVideoName = `${uploadVideoHash}.${uploadVideoExtension}`
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadVideoName
          }
          const data = new FormData()
          data.append('image', dataURItoBlob(input.current.value), uploadVideoName)
          await comfyFetch(`${comfyBaseUrl.value}/upload/image`, {
            method: 'POST',
            body: data,
          })
        }
      }
    }

    // Helper function to reset UI state on error
    function resetGenerationState() {
      imageGeneration.processing = false
      imageGeneration.currentState = 'no_start'
      const promptStore = usePromptStore()
      promptStore.promptSubmitted = false
    }

    /**
     * If the preset's workflow uses OVMS image nodes, ensure the OVMS image server
     * is running with the correct model. Returns the server URL on success, null if
     * the workflow doesn't need OVMS, or false on failure (caller should abort).
     */
    async function ensureOvmsImageServerIfNeeded(preset: Preset): Promise<string | null | false> {
      if (preset.type !== 'comfy') return null
      if (!workflowUsesOvmsImage(preset.comfyUiApiWorkflow)) return null

      const modelInput = imageGeneration.comfyInputs.find(
        (input) => 'nodeInput' in input && input.nodeInput === 'model',
      )
      const modelId =
        (modelInput && 'current' in modelInput ? String(modelInput.current.value) : '') ||
        preset.requiredModels?.[0]?.model ||
        ''

      if (!modelId) {
        errors.report(
          createAppError({
            category: 'generation',
            code: 'generation/ovms-no-model',
            userMessage: 'No model id configured for OVMS image generation.',
            surface: 'toast',
          }),
        )
        return false
      }

      try {
        const { keepModelsLoaded } = useDeveloperSettings()
        // Pass the current generation resolution so OVMS can statically reshape the image
        // pipeline when running on NPU (required by the NPU plugin). Ignored on other devices.
        const resolution = `${imageGeneration.width}x${imageGeneration.height}`
        const result = await window.electronAPI.ensureOvmsImageReady(
          'openvino-backend',
          modelId,
          keepModelsLoaded,
          resolution,
        )
        if (result.success && result.url) {
          return result.url
        }
        errors.report(
          createAppError({
            category: 'generation',
            code: 'generation/ovms-start-failed',
            userMessage: `Failed to start OVMS image server: ${result.error || 'unknown error'}`,
            surface: 'toast',
            context: { serviceName: 'openvino-backend' },
          }),
        )
        return false
      } catch (error) {
        errors.report(error, {
          category: 'generation',
          code: 'generation/ovms-error',
          userMessage: 'OVMS image server error.',
          surface: 'toast',
          context: { serviceName: 'openvino-backend' },
        })
        return false
      }
    }

    async function generate(
      imageIds: string[],
      mode: WorkflowModeType,
      sourceImage?: string,
      isRetry = false,
    ) {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') {
        console.warn('The selected preset is not a comfyui preset')
        return
      }
      // `isRetry` is the auto-retry that fires once the backend finishes starting.
      // It is a continuation of the same operation, so it must bypass the
      // re-entrancy guard (which still keeps `processing` true to drive the UI).
      if (imageGeneration.processing && !isRetry) {
        console.warn('Already processing')
        return
      }

      // Surface progress immediately so the chat tool widget and the desktop
      // overlay show a "starting" state instead of nothing while the backend
      // boots / the request is queued.
      imageGeneration.processing = true
      imageGeneration.currentState = 'start_backend'

      try {
        const result = await window.electronAPI.ensureComfyUIBackendRunning()
        if (!result.success) {
          errors.report(
            createAppError({
              category: 'generation',
              code: 'generation/backend-start-failed',
              userMessage: 'Failed to start the ComfyUI backend.',
              technicalMessage: result.error ?? 'ensureComfyUIBackendRunning returned failure',
              surface: 'toast',
              context: { serviceName: 'comfyui-backend' },
            }),
          )
          resetGenerationState()
          return
        }

        if (result.starting) {
          console.info('ComfyUI backend is starting, queueing generation request')
          pendingGenerationRequest.value = { imageIds, mode, sourceImage }
          // Keep the 'start_backend' indicator up; the auto-retry will continue
          // this operation once the backend reaches 'running'.
          return
        }
      } catch (error) {
        errors.report(error, {
          category: 'generation',
          code: 'generation/backend-check-failed',
          userMessage: 'Failed to check the ComfyUI backend.',
          surface: 'toast',
          context: { serviceName: 'comfyui-backend' },
        })
        resetGenerationState()
        return
      }

      if (comfyUiState.value?.status !== 'running') {
        console.warn('ComfyUI backend is not running. Current status:', comfyUiState.value?.status)
        pendingGenerationRequest.value = { imageIds, mode, sourceImage }
        // Keep the 'start_backend' indicator up; the auto-retry continues once running.
        return
      }

      if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
        console.warn('Websocket not open')
        resetGenerationState()
        return
      }

      // Validate required image inputs before execution
      const missingInputs = validateRequiredImageInputs()
      if (missingInputs.length > 0) {
        const inputLabels = missingInputs.join(', ')
        errors.report(
          createAppError({
            category: 'validation',
            code: 'generation/missing-image-inputs',
            userMessage: `Missing required image inputs: ${inputLabels}`,
            surface: 'toast',
          }),
        )
        resetGenerationState()
        return
      }

      try {
        imageGeneration.processing = true
        imageGeneration.currentState = 'install_workflow_components'
        await installCustomNodesForActivePresetFully()

        // Ensure OVMS image server is ready if the workflow uses OpenAI-compatible image nodes
        const ovmsImageUrl = await ensureOvmsImageServerIfNeeded(preset)
        if (ovmsImageUrl === false) {
          resetGenerationState()
          return
        }

        const platform = await window.electronAPI.getPlatform()
        const mutableWorkflow: ComfyUIApiWorkflow = JSON.parse(
          JSON.stringify(preset.comfyUiApiWorkflow),
        )
        generateIdx = 0
        const baseSeed =
          imageGeneration.seed === -1 ? Math.floor(Math.random() * 1000000) : imageGeneration.seed

        modifySettingInWorkflow(mutableWorkflow, 'inferenceSteps', imageGeneration.inferenceSteps)
        modifySettingInWorkflow(mutableWorkflow, 'height', imageGeneration.height)
        modifySettingInWorkflow(mutableWorkflow, 'width', imageGeneration.width)
        modifySettingInWorkflow(mutableWorkflow, 'prompt', imageGeneration.prompt)
        modifySettingInWorkflow(mutableWorkflow, 'negativePrompt', imageGeneration.negativePrompt)

        await modifyDynamicSettingsInWorkflow(mutableWorkflow, platform)

        if (ovmsImageUrl) {
          injectOvmsImageUrl(mutableWorkflow, ovmsImageUrl)
        }

        bypassOptionalModelNodes(mutableWorkflow)
        normalizeModelPathsInWorkflow(mutableWorkflow, platform)

        loaderNodes.value = [
          ...findKeysByClassType(mutableWorkflow, 'CheckpointLoaderSimple'),
          ...findKeysByClassType(mutableWorkflow, 'Unet Loader (GGUF)'),
          ...findKeysByClassType(mutableWorkflow, 'DualCLIPLoader (GGUF)'),
        ]
        queuedImages = Array.from({ length: imageGeneration.batchSize }, (_, i) => {
          const seed = baseSeed + i
          const settings = imageGeneration.getGenerationParameters()
          settings.seed = seed

          return {
            id: imageIds[i],
            mode: mode,
            sourceImageUrl: sourceImage,
            type: 'image' as const,
            imageUrl:
              'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E',
            state: 'queued' as const,
            settings,
            dynamicSettings: imageGeneration.comfyInputs.map((input) => ({
              ...input,
              current: input.current.value as never,
            })),
          }
        })
        for (const image of queuedImages) {
          modifySettingInWorkflow(mutableWorkflow, 'seed', `${image.settings.seed!.toFixed(0)}`)
          const result = await comfyFetch(`${comfyBaseUrl.value}/prompt`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              prompt: mutableWorkflow,
              client_id: clientId,
            }),
          })
          if (result.status > 299) {
            throw new Error(
              `ComfyUI Backend responded with ${result.status}: ${await result.text()}`,
            )
          }
        }
        imageGeneration.updateImage({
          ...queuedImages[0],
          state: 'generating',
        })
        imageGeneration.currentState = 'load_workflow_components'
      } catch (ex) {
        clearWatchdog()
        imageGeneration.failGeneration('The ComfyUI backend could not generate the image.')
        errors.report(ex, {
          category: 'generation',
          code: 'generation/request-failed',
          userMessage: 'The ComfyUI backend could not generate the image.',
          surface: 'toast',
          context: { serviceName: 'comfyui-backend' },
        })
        const promptStore = usePromptStore()
        promptStore.promptSubmitted = false
      }
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

    async function stop() {
      clearWatchdog()
      imageGeneration.stopping = true
      try {
        await comfyFetch(`${comfyBaseUrl.value}/queue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ clear: true }),
        })
        await comfyFetch(`${comfyBaseUrl.value}/interrupt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })
      } catch (error) {
        // Best-effort: even if the cancel request fails (e.g. backend already
        // gone), we still locally settle the in-flight items below so the UI is
        // never left stuck in a processing state.
        errors.report(error, {
          category: 'generation',
          code: 'generation/cancel-failed',
          userMessage: 'Could not reach the ComfyUI backend to cancel generation.',
          surface: 'silent',
          context: { serviceName: 'comfyui-backend' },
        })
      } finally {
        // Move in-flight items to a terminal 'stopped' state and unblock the UI.
        imageGeneration.cancelGeneration()
      }
    }

    return {
      generate,
      stop,
      free: freeMemoryAndUnloadModels,
      checkPresetRequirements,
      installMissingRequirements,
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

import { defineStore, acceptHMRUpdate } from 'pinia'
import { WebSocket } from 'partysocket'
import { ComfyUIApiWorkflow } from './presets'
import { useImageGenerationPresets, type MediaItem } from './imageGenerationPresets'
import { useI18N } from './i18n'
import * as toast from '../toast'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePresets, type ComfyUiPreset, type ComfyInput } from './presets'
import { z } from 'zod'

const WEBSOCKET_OPEN = 1

const settingToComfyInputsName = {
  seed: ['seed', 'noise_seed'],
  inferenceSteps: ['steps'],
  height: ['height'],
  width: ['width'],
  prompt: ['text'],
  negativePrompt: ['text'],
  guidanceScale: ['cfg'],
  scheduler: ['scheduler'],
  batchSize: ['batch_size'],
} satisfies Partial<Record<string, string[]>>

type ComfySetting = keyof typeof settingToComfyInputsName

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
    data: z.object({ exception_message: z.string().optional() }).passthrough(),
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
        ]),
      })
      .passthrough(),
  }),
])

const findKeysByTitle = (workflow: ComfyUIApiWorkflow, title: ComfySetting | 'loader' | string) =>
  Object.entries(workflow)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter(([_key, value]) => (value as any)?.['_meta']?.title === title)
    .map(([key, _value]) => key)

const findKeysByClassType = (workflow: ComfyUIApiWorkflow, classType: string) =>
  Object.entries(workflow)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter(([_key, value]) => (value as any)?.['class_type'] === classType)
    .map(([key, _value]) => key)

const findKeysByInputsName = (workflow: ComfyUIApiWorkflow, setting: ComfySetting) => {
  for (const inputName of settingToComfyInputsName[setting]) {
    if (inputName === 'text') continue
    const keys = Object.entries(workflow)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(([_key, value]) => (value as any)?.['inputs']?.[inputName ?? ''] !== undefined)
      .map(([key, _value]) => key)
    if (keys.length > 0) return keys
  }
  return []
}

const getInputNameBySettingAndKey = (
  workflow: ComfyUIApiWorkflow,
  key: string,
  setting: ComfySetting,
) => {
  for (const inputName of settingToComfyInputsName[setting]) {
    if (workflow[key]?.inputs?.[inputName ?? '']) return inputName
  }
  return ''
}

function modifySettingInWorkflow(
  workflow: ComfyUIApiWorkflow,
  setting: ComfySetting,
  value: unknown,
) {
  const keys =
    findKeysByTitle(workflow, setting).length > 0
      ? findKeysByTitle(workflow, setting)
      : findKeysByInputsName(workflow, setting)
  if (keys.length === 0) {
    console.error(`No key found for setting ${setting}. Stopping generation`)
    return
  }
  if (keys.length > 1) {
    console.warn(`Multiple keys found for setting ${setting}. Using first one`)
  }
  const key = keys[0]
  if (workflow[key]?.inputs?.[getInputNameBySettingAndKey(workflow, key, setting)] !== undefined) {
    workflow[key].inputs[getInputNameBySettingAndKey(workflow, key, setting)] = value
  }
}

export const useComfyUiPresets = defineStore(
  'comfyUiPresets',
  () => {
    const imageGeneration = useImageGenerationPresets()
    const presetsStore = usePresets()
    const i18nState = useI18N().state
    const comfyPort = computed(() => comfyUiState.value?.port)
    const comfyBaseUrl = computed(() => comfyUiState.value?.baseUrl)

    const websocket = ref<WebSocket | null>(null)
    const clientId = '12345'
    const loaderNodes = ref<string[]>([])
    let generateIdx: number = 0
    let queuedImages: MediaItem[] = []

    const backendServices = useBackendServices()
    const comfyUiState = computed(() => {
      return backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
    })

    async function installCustomNodesForActivePresetFully() {
      const presetNeedsToBeInstalled = await checkPresetRequirements()
      if (!presetNeedsToBeInstalled) return
      console.info('restarting comfyUI to finalize installation of required custom nodes')
      await backendServices.stopService('comfyui-backend')
      await triggerInstallPythonPackagesForActivePreset()
      await installCustomNodesForActivePreset()
      const startingResult = await backendServices.startService('comfyui-backend')
      if (startingResult !== 'running') {
        throw new Error('Failed to restart comfyUI. Required Nodes are not active.')
      }
      console.info('restart complete')
    }

    async function checkPresetRequirements() {
      const comfyUiRootPath = '../ComfyUI'
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') return false

      const customNodes = preset.requiredCustomNodes ?? []
      const pythonPackages = preset.requiredPythonPackages ?? []

      console.info('Checking preset requirements', {
        customNodes,
        pythonPackages,
      })

      const nodeChecks = await Promise.all(
        customNodes.map((node) =>
          window.electronAPI.comfyui.isCustomNodeInstalled(
            extractCustomNodeInfo(node),
            comfyUiRootPath,
          ),
        ),
      )
      const nodesNeedInstallation = nodeChecks.some((installed: boolean) => !installed)

      const packageChecks = await Promise.all(
        pythonPackages.map((pkg) => window.electronAPI.comfyui.isPackageInstalled(pkg)),
      )
      const packagesNeedInstallation = packageChecks.some((installed: boolean) => !installed)

      return nodesNeedInstallation || packagesNeedInstallation
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

    async function installCustomNodesForActivePreset(): Promise<boolean> {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') return false

      const requiredCustomNodes = preset.requiredCustomNodes ?? []
      const comfyUiRootPath = '../ComfyUI'

      const nodesToInstall: ComfyUICustomNodesRequestParameters[] = []
      for (const node of requiredCustomNodes) {
        const isInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
          extractCustomNodeInfo(node),
          comfyUiRootPath,
        )
        if (!isInstalled) {
          nodesToInstall.push(extractCustomNodeInfo(node))
        }
      }

      const results = await Promise.all(
        nodesToInstall.map((node) =>
          window.electronAPI.comfyui.downloadCustomNode(node, comfyUiRootPath),
        ),
      )

      const failedNodes = nodesToInstall.filter((_, index) => !results[index])
      if (failedNodes.length > 0) {
        const failedNodeNames = failedNodes.map((n) => `${n.username}/${n.repoName}`).join(', ')
        throw new Error(`Failed to install required comfyUI custom nodes: ${failedNodeNames}`)
      }

      return nodesToInstall.length > 0
    }

    async function triggerInstallPythonPackagesForActivePreset() {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') return

      const toBeInstalledPackages = preset.requiredPythonPackages ?? []
      console.info('Installing python packages', { toBeInstalledPackages })

      await backendServices.stopService('comfyui-backend')

      try {
        await Promise.all(
          toBeInstalledPackages.map((pkg) => window.electronAPI.comfyui.installPypiPackage(pkg)),
        )
        console.info('python package installation completed')
      } catch (error) {
        throw new Error(`Failed to install Python packages: ${error}`)
      }
    }

    function connectToComfyUi() {
      if (comfyUiState.value?.status !== 'running') {
        console.warn('ComfyUI backend not running, cannot start websocket')
        return
      }
      const comfyWsUrl = `ws://localhost:${comfyPort.value}/ws?clientId=${clientId}`
      console.info('Connecting to ComfyUI', { comfyWsUrl })
      websocket.value = new WebSocket(comfyWsUrl)
      websocket.value.binaryType = 'arraybuffer'
      websocket.value.addEventListener('message', (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data)
            const eventType = view.getUint32(0)
            const buffer = event.data.slice(4)
            switch (eventType) {
              case 1:
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
                if ('images' in output) {
                  const imageIndex = output.images.findIndex((i) => i.type === 'output')
                  const image = output.images[imageIndex]
                  if (image) {
                    let newItem: MediaItem
                    if (output?.animated?.[imageIndex]) {
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        videoUrl: `${comfyBaseUrl.value}/view?filename=${image.filename}&type=${image.type}&subfolder=${image.subfolder ?? ''}`,
                      }
                    } else {
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        imageUrl: `${comfyBaseUrl.value}/view?filename=${image.filename}&type=${image.type}&subfolder=${image.subfolder ?? ''}`,
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
                    const newImage: MediaItem = {
                      ...queuedImages[generateIdx],
                      state: 'done',
                      imageUrl: `${comfyBaseUrl.value}/view?filename=${video.workflow}&type=${video.type}&subfolder=${video.subfolder ?? ''}`,
                      videoUrl: `${comfyBaseUrl.value}/view?filename=${video.filename}&type=${video.type}&subfolder=${video.subfolder ?? ''}`,
                    }
                    imageGeneration.updateImage(newImage)
                    generateIdx++
                    // Update state when video is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                console.log('executed', { detail: msg.data })
                break
              case 'execution_start':
                imageGeneration.processing = true
                imageGeneration.currentState = 'load_workflow_components'
                console.log('execution_start', { detail: msg.data })
                break
              case 'execution_success':
                imageGeneration.processing = false
                console.log('execution_success', { detail: msg.data })
                break
              case 'execution_error':
                imageGeneration.processing = false
                imageGeneration.currentState = 'error'
                if (msg.data.exception_message) toast.error(msg.data.exception_message)
                break
              case 'execution_interrupted':
                imageGeneration.processing = false
                imageGeneration.currentState = 'no_start'
                break
              case 'execution_cached':
                break
            }
          }
        } catch (error) {
          console.warn('Unhandled message:', event.data, error)
        }
      })
    }

    watchEffect(() => {
      if (comfyPort && comfyUiState.value?.status === 'running') {
        connectToComfyUi()
      }
    })

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

    async function modifyDynamicSettingsInWorkflow(mutableWorkflow: ComfyUIApiWorkflow) {
      for (const input of imageGeneration.comfyInputs) {
        const keys = findKeysByTitle(mutableWorkflow, input.nodeTitle)
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
        if (input.type === 'image') {
          if (typeof input.current.value !== 'string') continue
          const uploadImageHash = Array.from(
            new Uint8Array(
              await window.crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(input.current.value),
              ),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          const uploadImageExtension = input.current.value.match(
            /data:image\/(png|jpeg|webp);base64,/,
          )?.[1]
          const uploadImageName = `${uploadImageHash}.${uploadImageExtension}`
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadImageName
          }
          const data = new FormData()
          data.append('image', dataURItoBlob(input.current.value), uploadImageName)
          await fetch(`${comfyBaseUrl.value}/upload/image`, {
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
          await fetch(`${comfyBaseUrl.value}/upload/image`, {
            method: 'POST',
            body: data,
          })
        }
      }
    }

    async function generate(
      imageIds: string[],
      mode: WorkflowModeType,
      sourceImage?: string,
    ) {
      const preset = imageGeneration.activePreset
      if (!preset || preset.type !== 'comfy') {
        console.warn('The selected preset is not a comfyui preset')
        return
      }
      if (imageGeneration.processing) {
        console.warn('Already processing')
        return
      }
      if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
        console.warn('Websocket not open')
        return
      }

      try {
        imageGeneration.processing = true
        imageGeneration.currentState = 'install_workflow_components'
        await installCustomNodesForActivePresetFully()

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

        await modifyDynamicSettingsInWorkflow(mutableWorkflow)

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
            imageUrl:
              'data:image/svg+xml,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22UTF-8%22%3F%3E%3Csvg%20width%3D%2224px%22%20height%3D%2224px%22%20viewBox%3D%220%200%2024%2024%22%20stroke-width%3D%221.5%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20color%3D%22%23000000%22%3E%3Cpath%20d%3D%22M12%2012C15.866%2012%2019%208.86599%2019%205H5C5%208.86599%208.13401%2012%2012%2012ZM12%2012C15.866%2012%2019%2015.134%2019%2019H5C5%2015.134%208.13401%2012%2012%2012Z%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M5%202L12%202L19%202%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M5%2022H12L19%2022%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
            state: 'queued',
            settings,
            dynamicSettings: imageGeneration.comfyInputs.map((input) => ({
              ...input,
              current: input.current.value as never,
            })),
          }
        })
        for (const image of queuedImages) {
          modifySettingInWorkflow(mutableWorkflow, 'seed', `${image.settings.seed!.toFixed(0)}`)
          const result = await fetch(`${comfyBaseUrl.value}/prompt`, {
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
        console.error('Error generating image', ex)
        toast.error('Backend could not generate image.')
        imageGeneration.processing = false
        imageGeneration.currentState = 'no_start'
      }
    }

    async function stop() {
      await fetch(`${comfyBaseUrl.value}/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clear: true }),
      })
      await fetch(`${comfyBaseUrl.value}/interrupt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    return {
      generate,
      stop,
    }
  },
  {
    persist: {
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComfyUiPresets, import.meta.hot))
}


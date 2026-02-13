import { defineStore, acceptHMRUpdate } from 'pinia'
import { WebSocket } from 'partysocket'
import { ComfyUIApiWorkflow } from './presets'
import { useImageGenerationPresets, type MediaItem } from './imageGenerationPresets'
import { useI18N } from './i18n'
import * as toast from '../toast'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePromptStore } from './promptArea'
import { z } from 'zod'

const WEBSOCKET_OPEN = 1

const settingToComfyInputsName = {
  seed: ['seed', 'noise_seed'],
  inferenceSteps: ['steps'],
  height: ['height'],
  width: ['width'],
  prompt: ['text'],
  negativePrompt: ['text'],
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
    console.warn(`No key found for setting ${setting}. Skipping this setting.`)
    return
  }
  if (keys.length > 1) {
    console.warn(`Multiple keys found for setting ${setting}. Using first one`)
  }
  const key = keys[0]
  const inputName = getInputNameBySettingAndKey(workflow, key, setting)
  if (workflow[key]?.inputs?.[inputName] !== undefined) {
    workflow[key].inputs[inputName] = value
  } else if (workflow[key]?.inputs?.['a'] !== undefined) {
    workflow[key].inputs['a'] = value
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
      const requirements = await checkPresetRequirements()
      if (!requirements.hasMissingRequirements) return
      console.info('restarting comfyUI to finalize installation of required custom nodes')
      await backendServices.stopService('comfyui-backend')
      await triggerInstallPythonPackagesForActivePreset() // Backend already stopped above
      await installCustomNodesForActivePreset()
      const startingResult = await backendServices.startService('comfyui-backend')
      if (startingResult !== 'running') {
        throw new Error('Failed to restart comfyUI. Required Nodes are not active.')
      }
      console.info('restart complete')
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
                      const videoUrl = `aipg-media://${image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename}`
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
                        imageUrl: `aipg-media://${image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename}`,
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
                    const videoUrl = `aipg-media://${video.subfolder ? `${video.subfolder}/${video.filename}` : video.filename}`
                    const thumbnailUrl = `aipg-media://${video.subfolder ? `${video.subfolder}/${video.workflow}` : video.workflow}`
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
                    const model3dUrl = `aipg-media://${model3d.subfolder ? `${model3d.subfolder}/${model3d.filename}` : model3d.filename}`
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
                const promptStore = usePromptStore()
                promptStore.promptSubmitted = false
                if (msg.data.exception_message) toast.error(msg.data.exception_message)
                break
              case 'execution_interrupted':
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

    function validateRequiredImageInputs(): string[] {
      const missingInputs: string[] = []

      for (const input of imageGeneration.comfyInputs) {
        // Skip optional image inputs - they will get black pixel injected
        if (input.optional === true) {
          continue
        }

        // Check if this is a required image input
        const isImageType = input.type === 'image' || input.type === 'inpaintMask'
        const isDisplayed = input.displayed !== false // defaults to true
        const isModifiable = input.modifiable !== false // defaults to true
        const hasNoDefault = input.defaultValue === '' || input.defaultValue === undefined

        if (isImageType && isDisplayed && isModifiable && hasNoDefault) {
          // Check if current value is empty or invalid
          const value = input.current.value
          const isEmpty = value === '' || value === undefined || value === null
          const isString = typeof value === 'string'
          const isValidDataUri = isString && value.match(/^data:image\/(png|jpeg|webp);base64,/)

          if (isEmpty || !isString || !isValidDataUri) {
            missingInputs.push(input.label)
          }
        }
      }

      return missingInputs
    }

    async function modifyDynamicSettingsInWorkflow(mutableWorkflow: ComfyUIApiWorkflow) {
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
        if (input.type === 'image' || input.type === 'inpaintMask') {
          // Check if image is optional and empty - if so, use black pixel
          const isEmpty =
            typeof input.current.value !== 'string' ||
            input.current.value === '' ||
            !input.current.value.match(/^data:image\/(png|jpeg|webp);base64,/)
          const isOptional = input.optional === true

          let imageDataUri: string
          if (isEmpty && isOptional && input.type === 'image') {
            // Use black pixel image for optional empty images
            imageDataUri =
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
          } else if (typeof input.current.value === 'string') {
            imageDataUri = input.current.value
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
          // For inpaintMask, always use PNG to preserve alpha channel
          // For regular images, extract extension from data URI
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

    // Helper function to reset UI state on error
    function resetGenerationState() {
      imageGeneration.processing = false
      imageGeneration.currentState = 'no_start'
      const promptStore = usePromptStore()
      promptStore.promptSubmitted = false
    }

    async function generate(imageIds: string[], mode: WorkflowModeType, sourceImage?: string) {
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

      // Validate required image inputs before execution
      const missingInputs = validateRequiredImageInputs()
      if (missingInputs.length > 0) {
        const inputLabels = missingInputs.join(', ')
        toast.error(`Missing required image inputs: ${inputLabels}`)
        resetGenerationState()
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
        resetGenerationState()
      }
    }

    async function freeMemoryAndUnloadModels() {
      await fetch(`${comfyBaseUrl.value}/free`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ free_memory: true, unload_models: true }),
      })
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
      // Immediately reset processing state to unblock UI
      imageGeneration.processing = false
      imageGeneration.currentState = 'no_start'
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
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComfyUiPresets, import.meta.hot))
}

import { usePresets } from './presets'
import { useTextInference } from './textInference'
import { usePromptStore } from './promptArea'
import { useImageGenerationPresets } from './imageGenerationPresets'
import type { ImageMediaItem } from './imageGenerationPresets'
import { useDemoMode } from './demoMode'
import demoInputImageUrl from '@/assets/image/dog_with_people.jpg'
import demoSketchInputImageUrl from '@/assets/image/sketch_of_building.png'
import demoUpscaleInputImageUrl from '@/assets/image/cat_low_resolution.png'

export const DEMO_CHAT_PRESET = 'Vision'
export const DEMO_CHAT_MODEL = 'unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-Q5_K_S.gguf'
export const DEMO_IMAGEGEN_PRESET = 'Pro Image'
export const DEMO_IMAGEEDIT_PRESET = 'Edit by Prompt 2'

export async function applyDemoModeExplicitDefaults(): Promise<void> {
  const presetsStore = usePresets()
  const textInference = useTextInference()
  const promptStore = usePromptStore()
  const profile = useDemoMode().profile

  const chatPreset = profile?.defaults.chatPreset ?? DEMO_CHAT_PRESET
  const chatModel = profile?.defaults.chatModel ?? DEMO_CHAT_MODEL
  const imageGenPreset = profile?.defaults.imageGenPreset ?? DEMO_IMAGEGEN_PRESET
  const imageEditPreset = profile?.defaults.imageEditPreset ?? DEMO_IMAGEEDIT_PRESET

  presetsStore.setLastUsedPreset('chat', chatPreset)
  promptStore.setCurrentMode('chat')

  textInference.backend = 'llamaCPP'
  textInference.selectModel('llamaCPP', chatModel)

  presetsStore.setLastUsedPreset('create-images', imageGenPreset)
  presetsStore.setLastUsedPreset('edit-images', imageEditPreset)
}

export async function populateImageEditHistory(
  imageGeneration: ReturnType<typeof useImageGenerationPresets>,
  presetName?: string,
) {
  const demoImageUrl = getDemoModeImageForPreset(presetName)
  if (!demoImageUrl) return

  const sourceItem: ImageMediaItem = {
    id: 'demo-source',
    type: 'image',
    state: 'done',
    mode: 'imageEdit',
    imageUrl: demoImageUrl,
    settings: {},
  }
  await imageGeneration.copyImageAsInputForMode(sourceItem, 'imageEdit')
}

export function getDemoModeInputImage(): string | null {
  return useDemoMode().profile?.inputImage ?? demoInputImageUrl
}

export function getDemoModeSketchInputImage(): string | null {
  return demoSketchInputImageUrl
}

export function getDemoModeUpscaleInputImage(): string | null {
  return demoUpscaleInputImageUrl
}

function getDemoModeImageForPreset(presetName?: string): string | null {
  switch (presetName) {
    case 'Sketch to Photo':
      return getDemoModeSketchInputImage()
    case 'Upscale':
      return getDemoModeUpscaleInputImage()
    default:
      return getDemoModeInputImage()
  }
}

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const INFERENCE_STORES = [
  'src/assets/js/store/textInference.ts',
  'src/assets/js/store/openAiCompatibleChat.ts',
  'src/assets/js/store/models.ts',
  'src/assets/js/store/comfyUiPresets.ts',
  'src/assets/js/store/imageGenerationPresets.ts',
  'src/assets/js/store/speechToText.ts',
  'src/assets/js/store/qwen3TextToSpeech.ts',
  'src/assets/js/store/agentMode.ts',
]

describe('inference stores do not import the dialog store', () => {
  it.each(INFERENCE_STORES)('%s has no useDialogStore', (relative) => {
    const src = readFileSync(resolve(__dirname, '../../..', relative), 'utf8')
    expect(src).not.toMatch(/useDialogStore/)
  })
})

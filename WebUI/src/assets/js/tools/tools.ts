import { InferUITools, ToolSet } from 'ai'
import { visualizeObjectDetections } from './visualizeObjectDetections'
import { comfyUI } from './comfyUi'
import { comfyUiImageEdit } from './comfyUiImageEdit'

export const availableTools = {
  comfyUI,
  comfyUiImageEdit,
  visualizeObjectDetections,
} satisfies ToolSet

export type AipgTools = InferUITools<typeof availableTools>

import { InferUITools, ToolSet } from 'ai'
import { visualizeObjectDetections } from './visualizeObjectDetections'
import { comfyUI } from './comfyUi'

export const availableTools = {
  comfyUI,
  visualizeObjectDetections,
} satisfies ToolSet

export type AipgTools = InferUITools<typeof availableTools>

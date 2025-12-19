import { InferUITools, ToolSet } from 'ai'
import { visualizeObjectDetections } from './visualizeObjectDetections'
import { comfyUI } from './comfyUi'

const _tools = {
  comfyUI,
  visualizeObjectDetections,
} satisfies ToolSet

export type AipgTools = InferUITools<typeof _tools>

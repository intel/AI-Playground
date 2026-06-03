import { InferUITools, ToolSet } from 'ai'
import { visualizeObjectDetections } from './visualizeObjectDetections'
import { comfyUI } from './comfyUi'
import { comfyUiImageEdit } from './comfyUiImageEdit'
import { captureScreenshot } from './captureScreenshot'
import { browseWeb, interactWithWebPage } from './browseWeb'
import { configureHomeAgent, getHomeAgentSettings, listHomeAgentModels } from './configureHomeAgent'

export const aipgTools = {
  comfyUI,
  comfyUiImageEdit,
  visualizeObjectDetections,
  captureScreenshot,
  browseWeb,
  interactWithWebPage,
} satisfies ToolSet

export type AipgTools = InferUITools<typeof aipgTools>

/**
 * Tools offered only to the Home Agent preset (gated in `resolveBuiltinTools()`).
 * Kept separate from `aipgTools` on purpose: folding them into the
 * `InferUITools<typeof aipgTools>` inference above tips TypeScript over its
 * recursion limit and collapses the whole message-type graph to `any`. These
 * are merged into the runtime `ToolSet` instead, without widening `AipgTools`.
 */
export const homeAgentTools = {
  getHomeAgentSettings,
  listHomeAgentModels,
  configureHomeAgent,
} satisfies ToolSet

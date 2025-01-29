/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    DIST: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import('electron').IpcRenderer
}

type KVObject = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

type Theme = 'dark' | 'lnl' | 'bmg'

type LocalSettings = {
  debug: number
  comfyUiParameters?: string[]
} & KVObject

type ThemeSettings = {
  availableThemes: Theme[]
  currentTheme: Theme
}

type ModelPaths = {
  llm: string
  embedding: string
  stableDiffusion: string
  inpaint: string
  lora: string
  vae: string
} & StringKV

type ModelLists = {
  llm: string[]
  stableDiffusion: string[]
  lora: string[]
  vae: string[]
  scheduler: string[]
  embedding: string[]
  inpaint: string[]
} & { [key: string]: Array<string> }

type SetupData = {
  modelPaths: ModelPaths
  modelLists: ModelLists
  isAdminExec: boolean
  version: string
}

type UpdateWorkflowsFromIntelResult = {
  success: boolean
  backupDir: string
}

type BackendStatus =
  | 'notYetStarted'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'stopping'
  | 'failed'
  | 'notInstalled'
  | 'installationFailed'
  | 'installing'
  | 'uninitializedStatus'

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
  debug: boolean
  comfyUiParameters: string[]
  deviceArchOverride: 'bmg' | 'acm' | 'arl_h' | 'lnl' | 'mtl' | null
  enablePreviewFeatures: boolean
  isAdminExec: boolean
  availableThemes: Theme[],
  currentTheme: Theme,
  isDemoModeEnabled: boolean,
  demoModeResetInSeconds: number | null,
  languageOverride: string | null,
  remoteRepository: string,
}

type LocaleSettings = {
  locale: string
  languageOverride: string | null
}

type ThemeSettings = {
  availableThemes: Theme[]
  currentTheme: Theme
}

type SetupData = {
  modelPaths: ModelPaths
  modelLists: ModelLists
  isAdminExec: boolean
  version: string
}

type UpdateWorkflowsFromIntelResult = {
  result: 'success' | 'error' | 'noUpdate'
  backupDir?: string
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

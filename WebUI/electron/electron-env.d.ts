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
    DIST: string;
    /** /dist/ or /public/ */
    VITE_PUBLIC: string;
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import("electron").IpcRenderer;
}

type KVObject = {
  [key: string]: any;
};

type LocalSettings = {
  apiHost: string;
  settingPath: string;
  debug: number;
  envType: string;
  port:number;
} & KVObject;

type ModelPaths = {
  llm: string,
  embedding: string,
  stableDiffusion: string,
  inpaint: string,
  lora: string,
  vae: string,
} & StringKV

type ModelLists = {
  llm: string[],
  stableDiffusion: string[],
  lora: string[],
  vae: string[],
  scheduler: string[],
  embedding: string[],
  inpaint: string[]
} & { [key: string]: Array<string> }

type SetupData = {
  apiHost:string,
  modelPaths: ModelPaths,
  modelLists: ModelLists,
  envType: string,
  isAdminExec:boolean,
  version:string,
}
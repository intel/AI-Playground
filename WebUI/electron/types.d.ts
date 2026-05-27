// Type declarations for the WebUI project

declare type BackendServiceName =
  | 'ai-backend'
  | 'comfyui-backend'
  | 'llamacpp-backend'
  | 'openvino-backend'
  | 'home-agent-backend'

// Declare BackendStatus type
declare type BackendStatus =
  | 'notInstalled'
  | 'installing'
  | 'installationFailed'
  | 'notYetStarted'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'uninitializedStatus'

// Declare SetupProgress type
declare interface SetupProgress {
  serviceName: string
  step: string
  status: 'executing' | 'success' | 'failed'
  debugMessage: string
  errorDetails?: {
    command?: string
    exitCode?: number
    stdout?: string
    stderr?: string
    timestamp?: string
    duration?: number
    pipFreezeOutput?: string
  }
}

declare interface InferenceDevice {
  id: string
  name: string
  selected: boolean
}

declare type StorageTarget = {
  id: string
  name: string
  path: string
  selected: boolean
}

declare interface ErrorDetails {
  command?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  timestamp?: string
  duration?: number
  pipFreezeOutput?: string
}

// Declare ApiServiceInformation type
declare interface ApiServiceInformation {
  serviceName: string
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: InferenceDevice[]
  storageTargets?: StorageTarget[]
  llamaCppSsdOffloadConfigPath?: string
  sttDevices?: InferenceDevice[]
  errorDetails: ErrorDetails | null
  installedVersion?: { version: string; releaseTag?: string }
  /** Populated by llamacpp-backend: GGUF tree under llama-cpp/ */
  llamaCppStandardArtifactReady?: boolean
  llamaCppPhisonArtifactReady?: boolean
  llamaCppStandardInstalledVersion?: { version: string; releaseTag?: string }
  llamaCppPhisonInstalledVersion?: { version: string; releaseTag?: string }
}

// Declare ComfyUICustomNodeRepoId type
declare interface ComfyUICustomNodeRepoId {
  username: string
  repoName: string
  gitRef?: string
}

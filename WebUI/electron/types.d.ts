// Type declarations for the WebUI project

// Extend BackendServiceName to include 'ollama-backend'
declare type BackendServiceName =
  | 'ai-backend'
  | 'comfyui-backend'
  | 'llamacpp-backend'
  | 'openvino-backend'
  | 'ollama-backend'

// Declare ServiceSettings type
declare interface ServiceSettings {
  serviceName: BackendServiceName
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

// Declare LocalSettings type
declare interface LocalSettings {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

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
  }
}

// Declare ApiServiceInformation type
declare interface ApiServiceInformation {
  serviceName: string
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
}

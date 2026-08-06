import type { BackendServiceName } from '@/assets/js/store/backendServices'

/**
 * Display name (the accessible row label in the wizard) for each backend service.
 * Keyed by the app's `BackendServiceName` union via `satisfies Record<...>`, so
 * adding or removing a backend in the app surfaces here as a type error. Mirrors
 * `mapServiceNameToDisplayName` in the app.
 */
export const BACKEND_DISPLAY_NAMES = {
  'ai-backend': 'AI Playground',
  'home-agent-backend': 'Home Agent',
  'qwen3-tts-backend': 'Text To Speech (Qwen3-TTS)',
  'llamacpp-backend': 'Llama.cpp - GGUF',
  'openvino-backend': 'OpenVINO',
  'comfyui-backend': 'ComfyUI',
} as const satisfies Record<BackendServiceName, string>

/** Union of the backend row labels, e.g. 'AI Playground' | 'OpenVINO' | ... */
export type BackendDisplayName = (typeof BACKEND_DISPLAY_NAMES)[BackendServiceName]

/**
 * The backends this suite installs (no Home Agent — it's deactivated via its
 * toggle; Cloud Mode is a frontend-only row and is left untouched).
 * `required` backends can't be toggled off; `hasVersionAction` marks backends
 * whose gear menu can offer an "Update to <version>" action (ai-backend has no
 * tracked version, so it never does).
 */
export type Backend = {
  serviceName: BackendServiceName
  displayName: BackendDisplayName
  required: boolean
  hasVersionAction: boolean
}

export const BACKENDS: Backend[] = [
  {
    serviceName: 'ai-backend',
    displayName: BACKEND_DISPLAY_NAMES['ai-backend'],
    required: true,
    hasVersionAction: false,
  },
  {
    serviceName: 'llamacpp-backend',
    displayName: BACKEND_DISPLAY_NAMES['llamacpp-backend'],
    required: false,
    hasVersionAction: true,
  },
  {
    serviceName: 'openvino-backend',
    displayName: BACKEND_DISPLAY_NAMES['openvino-backend'],
    required: false,
    hasVersionAction: true,
  },
  {
    serviceName: 'comfyui-backend',
    displayName: BACKEND_DISPLAY_NAMES['comfyui-backend'],
    required: false,
    hasVersionAction: true,
  },
]

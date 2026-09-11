import type { BackendServiceName } from '@/assets/js/store/backendServices'
// Zero-dependency policy module (no app imports of its own), so the suite can
// share the app's own list of nested rows instead of restating it.
import { CORE_DEPENDENT_BACKENDS } from '@/lib/wizardInstallDefaults'

/**
 * Display name (the accessible row label in the wizard) for each backend service.
 * Keyed by the app's `BackendServiceName` union via `satisfies Record<...>`, so
 * adding or removing a backend in the app surfaces here as a type error. Mirrors
 * `wizardDisplayName` in the app — note that is the shared
 * `mapServiceNameToDisplayName` with one wizard-only override: `ai-backend` reads
 * "Core Services" inside the "AI Playground" group box (elsewhere it keeps the
 * product name). The override also keeps the row's accessible name distinct from
 * the group's, so locating either one stays unambiguous.
 */
export const BACKEND_DISPLAY_NAMES = {
  'ai-backend': 'Core Services',
  'home-agent-backend': 'Home Agent',
  'qwen3-tts-backend': 'Text To Speech (Qwen3-TTS)',
  'whisper-backend': 'Speech To Text (Standalone Whisper)',
  'llamacpp-backend': 'Llama.cpp - GGUF',
  'openvino-backend': 'OpenVINO',
  'comfyui-backend': 'ComfyUI',
} as const satisfies Record<BackendServiceName, string>

/** Union of the backend row labels, e.g. 'Core Services' | 'OpenVINO' | ... */
export type BackendDisplayName = (typeof BACKEND_DISPLAY_NAMES)[BackendServiceName]

/** The row that owns the nested speech sidecars (the wizard's disclosure). */
export const CORE_SERVICES_DISPLAY_NAME = BACKEND_DISPLAY_NAMES['ai-backend']

/**
 * Rows nested behind the Core Services disclosure. They are collapsed on every
 * wizard open and their markup is unmounted while closed, so any interaction
 * with one has to expand the disclosure first.
 */
export const CORE_DEPENDENT_DISPLAY_NAMES: BackendDisplayName[] = CORE_DEPENDENT_BACKENDS.map(
  (name) => BACKEND_DISPLAY_NAMES[name],
)

/**
 * The backends this suite installs (no Home Agent — it is off by default and
 * re-disabled on reopen; Hybrid Cloud is a frontend-only row and is left
 * untouched; the speech sidecars ride along with Core Services).
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

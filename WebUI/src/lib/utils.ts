import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useI18N } from '@/assets/js/store/i18n.ts'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function mapStatusToColor(componentState: BackendStatus) {
  switch (componentState) {
    case 'running':
      return '#66BB55'
    case 'installationFailed':
    case 'failed':
      return '#ef335e'
    case 'notInstalled':
      return '#bbc2c5'
    case 'notYetStarted':
    case 'stopped':
      return 'orange'
    case 'starting':
    case 'stopping':
    case 'installing':
      return '#e1cb50'
    default:
      return 'blue'
  }
}

export function mapToDisplayStatus(componentState: BackendStatus) {
  const i18nState = useI18N().state
  switch (componentState) {
    case 'running':
      return i18nState.BACKEND_STATUS_RUNNING
    case 'stopping':
      return i18nState.BACKEND_STATUS_STOPPING
    case 'starting':
      return i18nState.BACKEND_STATUS_STARTING
    case 'stopped':
    case 'notYetStarted':
      return i18nState.BACKEND_STATUS_INSTALLED
    case 'installationFailed':
    case 'failed':
      return i18nState.BACKEND_STATUS_FAILED
    case 'notInstalled':
      return i18nState.BACKEND_STATUS_NOT_INSTALLED
    case 'installing':
      return i18nState.BACKEND_STATUS_INSTALLING
    default:
      return componentState
  }
}

export function mapServiceNameToDisplayName(serviceName: string) {
  switch (serviceName) {
    case 'comfyui-backend':
      return 'ComfyUI'
    case 'ai-backend':
      return 'AI Playground'
    case 'llamacpp-backend':
      return 'Llama.cpp - GGUF'
    case 'openvino-backend':
      return 'OpenVINO'
    default:
      return serviceName
  }
}

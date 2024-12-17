import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function mapStatusToColor(componentState: BackendStatus) {
  switch (componentState) {
    case "running":
      return '#66BB55'
    case "installationFailed":
    case "failed":
      return '#ef335e'
    case "notInstalled":
      return '#bbc2c5'
    case "notYetStarted":
    case "stopped":
      return 'orange'
    case "starting":
    case "stopping":
    case "installing":
      return "#e1cb50"
    default:
      return 'blue'
  }
}

export function mapToDisplayStatus(componentState: BackendStatus) {
  switch (componentState) {
    case "running":
      return "Running"
    case "stopping":
      return "Stopping"
    case "starting":
        return "Starting"
    case "stopped":
    case "notYetStarted":
      return "Installed"
    case "installationFailed":
    case "failed":
      return "Failed"
    case "notInstalled":
      return "Not Installed"
    case "installing":
      return "Installing"
    default:
      return componentState
  }
}

export function mapServiceNameToDisplayName(serviceName: string) {
  switch (serviceName) {
    case "comfyui-backend":
      return "ComfyUI"
    case "ai-backend":
      return "AI Playground"
    case "llamacpp-backend":
      return "Llama.cpp - GGUF"
    default:
      return serviceName
  }
}

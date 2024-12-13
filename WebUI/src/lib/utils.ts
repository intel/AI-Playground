import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function mapStatusToColor(componentState: BackendStatus) {
  switch (componentState) {
    case "starting":
    case "installing":
    case "running":
      return 'green'
    case "installationFailed":
    case "failed":
      return 'red'
    case "notInstalled":
      return 'gray'
    case "notYetStarted":
    case "stopped":
      return 'orange'
    default:
      return 'blue'
  }
}

export function mapToDisplayStatus(componentState: BackendStatus) {
  switch (componentState) {
    case "running":
      return "Running"
    case "stopped":
    case "notYetStarted":
      return "Not Running"
    case "installationFailed":
    case "failed":
      return "Failed"
    case "notInstalled":
      return "Not Installed"
    default:
      return componentState
  }
}

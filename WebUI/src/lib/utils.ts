import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function mapColorToStatus(status: string) {
  switch (status) {
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
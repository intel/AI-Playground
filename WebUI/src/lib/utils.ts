import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function mapColorToStatus(status: string) {
  switch (status) {
    case "running":
      return 'green'
    case "failed":
      return 'red'
    case "uninitialized":
      return 'gray'
    default:
      return 'blue'
  }
}
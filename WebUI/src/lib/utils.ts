import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useI18N } from '@/assets/js/store/i18n.ts'

/**
 * Compares two version strings using numeric segment comparison.
 * Handles versions like "v0.10.0", "b7446", "2025.4.0", "v2.3.0-nightly".
 *
 * Non-numeric prefixes (e.g. "v", "b") are stripped before comparison.
 * Pre-release suffixes after a hyphen (e.g. "-nightly") are ignored.
 * Each dot-separated segment is compared numerically; non-numeric segments
 * fall back to lexicographic comparison.
 *
 * @returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) =>
    v
      .replace(/^[a-z]+/i, '') // strip leading non-numeric prefix ("v", "b", etc.)
      .split('-')[0] // drop pre-release suffix ("-nightly", "-rc1", etc.)

  const partsA = normalize(a).split('.')
  const partsB = normalize(b).split('.')
  const length = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < length; i++) {
    const segA = partsA[i] ?? '0'
    const segB = partsB[i] ?? '0'
    const numA = Number(segA)
    const numB = Number(segB)

    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA - numB
    } else {
      if (segA < segB) return -1
      if (segA > segB) return 1
    }
  }
  return 0
}

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
    case 'ollama-backend':
      return 'Ollama'
    default:
      return serviceName
  }
}

export function mapModeToText(value: number | undefined) {
  const i18nState = useI18N().state
  switch (value) {
    case 0:
      return i18nState.TAB_CREATE
    case 1:
      return i18nState.ENHANCE_UPSCALE
    case 2:
      return i18nState.ENHANCE_IMAGE_PROMPT
    case 3:
      return i18nState.ENHANCE_INPAINT
    case 4:
      return i18nState.ENHANCE_OUTPAINT
    default:
      return 'unknown'
  }
}

export function mapModeToLabel(mode: ModeType) {
  const i18nState = useI18N().state
  switch (mode) {
    case 'chat':
      return i18nState.MODE_CHAT
    case 'imageGen':
      return i18nState.MODE_IMAGE_GEN
    case 'imageEdit':
      return i18nState.MODE_IMAGE_EDIT
    case 'video':
      return i18nState.MODE_VIDEO
    default:
      return 'unknown'
  }
}

export function getTranslationLabel(prefix: string, label: string) {
  return prefix + label.replace(/ - /g, '_').replace(/-/g, '_').replace(/ /g, '_').toUpperCase()
}

/**
 * Checks if an image is the NSFW blocked placeholder (512x512 completely black image).
 * The safety checker outputs this image when NSFW content is detected.
 * @param imageUrl - The URL of the image to check
 * @returns A Promise that resolves to true if the image is the NSFW blocked placeholder
 */
export async function checkIfNsfwBlocked(imageUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()

    img.onload = () => {
      // Check if image is exactly 512x512
      if (img.width !== 512 || img.height !== 512) {
        resolve(false)
        return
      }

      // Create canvas to read pixels
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        resolve(false)
        return
      }

      ctx.drawImage(img, 0, 0)

      // Sample pixels at various positions to check if all black
      // We sample a grid of points rather than checking every pixel for performance
      const samplePoints = [
        [0, 0],
        [255, 0],
        [511, 0],
        [0, 255],
        [255, 255],
        [511, 255],
        [0, 511],
        [255, 511],
        [511, 511],
        [128, 128],
        [384, 384],
        [64, 448],
        [448, 64],
      ]

      for (const [x, y] of samplePoints) {
        const pixel = ctx.getImageData(x, y, 1, 1).data
        // Check if pixel is black (R, G, B all 0, with some tolerance for compression artifacts)
        if (pixel[0] > 5 || pixel[1] > 5 || pixel[2] > 5) {
          resolve(false)
          return
        }
      }

      // All sampled pixels are black, this is likely the NSFW blocked image
      resolve(true)
    }

    img.onerror = () => {
      resolve(false)
    }

    img.src = imageUrl
  })
}

/**
 * Checks if a string is a valid base64 data URI for an image.
 * @param url - The string to check
 * @returns true if the string is a valid base64 image data URI
 */
export function isBase64ImageDataUri(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false
  return /^data:image\/(png|jpeg|webp);base64,/.test(url)
}

/**
 * Converts a blob URL (or any image URL) to a base64 data URI.
 * If the URL is already a base64 data URI, it returns it unchanged.
 * @param url - The URL to convert (blob:, http:, or data: URL)
 * @returns A Promise that resolves to a base64 data URI
 */
export async function imageUrlToDataUri(url: string): Promise<string> {
  // If already a base64 data URI, return as-is
  if (isBase64ImageDataUri(url)) {
    return url
  }

  // Fetch the URL and convert to base64
  const response = await fetch(url)
  const blob = await response.blob()

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to convert image to data URI'))
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function downscaleImageTo1MP(file: File): Promise<File> {
  const MAX_PIXELS = 1_000_000 // 1MP

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      const currentPixels = img.width * img.height

      // If image is already <= 1MP, return original file
      if (currentPixels <= MAX_PIXELS) {
        resolve(file)
        return
      }

      // Calculate new dimensions maintaining aspect ratio
      const scale = Math.sqrt(MAX_PIXELS / currentPixels)
      const newWidth = Math.round(img.width * scale)
      const newHeight = Math.round(img.height * scale)

      // Create canvas and draw resized image
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        console.error('Failed to get canvas context, using original file')
        resolve(file)
        return
      }

      ctx.drawImage(img, 0, 0, newWidth, newHeight)

      // Determine file type and quality
      const fileType = file.type || 'image/jpeg'
      const isJPEG = fileType === 'image/jpeg' || fileType === 'image/jpg'
      const isWebP = fileType === 'image/webp'
      const mimeType = isJPEG ? 'image/jpeg' : isWebP ? 'image/webp' : 'image/png'
      const quality = isJPEG || isWebP ? 0.92 : undefined

      // Convert canvas to blob and then to File
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            console.error('Failed to create blob from canvas, using original file')
            resolve(file)
            return
          }

          const downscaledFile = new File([blob], file.name, {
            type: mimeType,
            lastModified: file.lastModified,
          })
          resolve(downscaledFile)
        },
        mimeType,
        quality,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      console.error('Failed to load image for downscaling, using original file')
      resolve(file)
    }

    img.src = url
  })
}

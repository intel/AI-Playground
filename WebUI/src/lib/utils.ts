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

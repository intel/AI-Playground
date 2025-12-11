import * as toast from '@/assets/js/toast.ts'
import { useModels } from './models'

// Fixed resolution lookup table ensuring consistent inversions between portrait/landscape pairs
// All values are divisible by 32 (most by 64)
// Portrait ratios are derived by swapping width/height of their landscape counterparts
// Uses `/` notation consistently (e.g., '16/9' not '16:9')
export const RESOLUTION_TABLE: Record<string, Record<string, [number, number]>> = {
  '0.25': {
    '1/1': [512, 512],
    '4/3': [576, 448],
    '3/4': [448, 576],
    '3/2': [640, 448],
    '2/3': [448, 640],
    '16/9': [672, 384],
    '9/16': [384, 672],
    '21/9': [768, 320],
    '9/21': [320, 768],
  },
  '0.5': {
    '1/1': [704, 704],
    '4/3': [832, 640],
    '3/4': [640, 832],
    '3/2': [896, 576],
    '2/3': [576, 896],
    '16/9': [960, 544],
    '9/16': [544, 960],
    '21/9': [1088, 448],
    '9/21': [448, 1088],
  },
  '0.8': {
    '1/1': [896, 896],
    '4/3': [1024, 768],
    '3/4': [768, 1024],
    '3/2': [1088, 704],
    '2/3': [704, 1088],
    '16/9': [1216, 672],
    '9/16': [672, 1216],
    '21/9': [1344, 576],
    '9/21': [576, 1344],
  },
  '1.0': {
    '1/1': [1024, 1024],
    '4/3': [1152, 896],
    '3/4': [896, 1152],
    '3/2': [1216, 832],
    '2/3': [832, 1216],
    '16/9': [1376, 768],
    '9/16': [768, 1376],
    '21/9': [1536, 640],
    '9/21': [640, 1536],
  },
  '1.2': {
    '1/1': [1120, 1120],
    '4/3': [1280, 960],
    '3/4': [960, 1280],
    '3/2': [1376, 928],
    '2/3': [928, 1376],
    '16/9': [1504, 832],
    '9/16': [832, 1504],
    '21/9': [1664, 704],
    '9/21': [704, 1664],
  },
  '1.5': {
    '1/1': [1248, 1248],
    '4/3': [1440, 1088],
    '3/4': [1088, 1440],
    '3/2': [1536, 1024],
    '2/3': [1024, 1536],
    '16/9': [1664, 928],
    '9/16': [928, 1664],
    '21/9': [1856, 768],
    '9/21': [768, 1856],
  },
}

// Mapping for legacy notation (colon) to standard notation (slash)
const ASPECT_RATIO_MAP: Record<string, string> = {
  '1:1': '1/1',
  '4:3': '4/3',
  '3:4': '3/4',
  '3:2': '3/2',
  '2:3': '2/3',
  '16:9': '16/9',
  '9:16': '9/16',
  '21:9': '21/9',
  '9:21': '9/21',
  '12/5': '21/9', // 12:5 = 2.4, close to 21:9 = 2.333
  '5/12': '9/21',
}

export type MegapixelTier = '0.25' | '0.5' | '0.8' | '1.0' | '1.2' | '1.5'

/**
 * Get resolution from the fixed lookup table
 * @param megapixels - The megapixel tier (e.g., '0.25', '0.5', '0.8', '1.0', '1.2', '1.5')
 * @param aspectRatio - The aspect ratio in fractional or colon notation (e.g., '16/9', '16:9', '9/16')
 * @returns Resolution object with width, height, and totalPixels
 */
export function getResolutionFromTable(
  megapixels: string,
  aspectRatio: string,
): { width: number; height: number; totalPixels: number } | null {
  const mpTable = RESOLUTION_TABLE[megapixels]
  if (!mpTable) return null

  // Convert fractional notation to colon notation if needed
  const normalizedRatio = ASPECT_RATIO_MAP[aspectRatio] || aspectRatio

  const resolution = mpTable[normalizedRatio]
  if (!resolution) return null

  const [width, height] = resolution
  return { width, height, totalPixels: width * height }
}

/**
 * Get all resolutions for a given megapixel tier
 * @param megapixels - The megapixel tier
 * @returns Array of resolution objects with aspectRatio, width, height, and totalPixels
 */
export function getResolutionsForMegapixel(megapixels: string): Array<{
  aspectRatio: string
  width: number
  height: number
  totalPixels: number
}> {
  const mpTable = RESOLUTION_TABLE[megapixels]
  if (!mpTable) return []

  return Object.entries(mpTable).map(([ratio, [width, height]]) => ({
    aspectRatio: ratio,
    width,
    height,
    totalPixels: width * height,
  }))
}

/**
 * Dynamic resolution calculation - used as fallback for special cases like LTX Video
 * Kept for backward compatibility
 */
export function findBestResolution(totalPixels: number, aspectRatio: number) {
  const MIN_SIZE = 256
  const MAX_SIZE = 1920
  let bestWidth = 0
  let bestHeight = 0
  let minDiff = Infinity

  for (let h = MIN_SIZE; h <= MAX_SIZE; h += 64) {
    let w = aspectRatio * h
    w = Math.round(w / 64) * 64

    if (w < MIN_SIZE || w > MAX_SIZE) continue

    const actualPixels = w * h
    const diff = Math.abs(actualPixels - totalPixels)

    if (diff < minDiff) {
      minDiff = diff
      bestWidth = w
      bestHeight = h
    }
  }

  return { width: bestWidth, height: bestHeight, totalPixels: bestWidth * bestHeight }
}

function extractDownloadModelParamsFromString(requiredModel: {
  type: string
  model: string
  additionalLicenceLink?: string
}) {
  return {
    repo_id: requiredModel.model,
    type: requiredModel.type,
    backend: 'comfyui' as const,
    additionalLicenseLink: requiredModel.additionalLicenceLink,
  }
}

export async function getMissingComfyuiBackendModels(
  requiredModels: { type: string; model: string; additionalLicenceLink?: string }[],
): Promise<DownloadModelParam[]> {
  const models = useModels()

  const checkList = requiredModels.map(extractDownloadModelParamsFromString)
  const checkedModels = await models.checkModelAlreadyLoaded(checkList)
  const modelsToBeLoaded = checkedModels.filter(
    (checkModelExistsResult) => !checkModelExistsResult.already_loaded,
  )
  for (const item of modelsToBeLoaded) {
    if (!(await models.checkIfHuggingFaceUrlExists(item.repo_id))) {
      toast.error(`declared model ${item.repo_id} does not exist. Aborting Generation.`)
      return []
    }
  }
  return modelsToBeLoaded
}

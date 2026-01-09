/**
 * NVIDIA GPU detection utilities shared across backends (ComfyUI and LlamaCPP)
 */

import { promisify } from 'util'
import { exec } from 'child_process'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(exec)

export interface NvidiaDevice {
  id: string
  name: string
}

/**
 * Detect NVIDIA GPUs using nvidia-smi
 * Returns array of detected devices or empty array if none found
 *
 * This is the canonical method for detecting NVIDIA GPUs across all backends
 * to ensure consistent behavior.
 *
 * @param serviceName - The name of the service calling this function (for logging)
 * @returns Promise resolving to array of detected NVIDIA devices
 */
export async function detectNvidiaGpus(serviceName: string): Promise<NvidiaDevice[]> {
  const devices: NvidiaDevice[] = []

  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name --format=csv,noheader', {
      timeout: 10000,
    })

    const lines = stdout.split('\n').filter((line) => line.trim() !== '')

    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim())
      if (parts.length >= 2) {
        const deviceId = parts[0]
        const deviceName = parts[1]
        devices.push({ id: deviceId, name: deviceName })
      }
    }

    appLoggerInstance.info(`Detected ${devices.length} NVIDIA GPU(s)`, serviceName)
  } catch (error) {
    appLoggerInstance.warn(`nvidia-smi not available or failed: ${error}`, serviceName)
  }

  return devices
}

/**
 * Check if NVIDIA drivers are available by running nvidia-smi
 *
 * @param serviceName - The name of the service calling this function (for logging)
 * @returns Promise resolving to true if NVIDIA drivers are available
 */
export async function checkNvidiaDrivers(serviceName: string): Promise<boolean> {
  try {
    const result = await execAsync('nvidia-smi', { timeout: 5000 })
    if (result.stdout) {
      appLoggerInstance.info('NVIDIA GPU detected and ready', serviceName)
      return true
    }
  } catch {
    appLoggerInstance.warn('nvidia-smi not found - NVIDIA drivers not available', serviceName)
  }
  return false
}

/**
 * Check if a device name appears to be an NVIDIA GPU
 *
 * @param deviceName - The device name to check
 * @returns true if the device name suggests it's an NVIDIA GPU
 */
export function isNvidiaDevice(deviceName: string): boolean {
  const lowerName = deviceName.toLowerCase()
  return (
    lowerName.includes('nvidia') ||
    lowerName.includes('geforce') ||
    lowerName.includes('rtx') ||
    lowerName.includes('gtx') ||
    lowerName.includes('quadro') ||
    lowerName.includes('tesla')
  )
}

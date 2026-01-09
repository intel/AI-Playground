/**
 * Shared utilities for device detection and management across different backends
 */

import { appLoggerInstance } from '../logging/logger.ts'
import { isIntelDevice } from './deviceArch.ts'
import { isNvidiaDevice } from './deviceNvidia.ts'

export type DeviceType = 'CUDA' | 'XPU' | 'CPU'
export type GpuVendor = 'nvidia' | 'intel' | 'unknown'

export interface DetectedDevice {
  id: string
  name: string
}

/**
 * Detect GPU vendor from device name
 */
export function detectGpuVendor(deviceName: string): GpuVendor {
  if (isNvidiaDevice(deviceName)) {
    return 'nvidia'
  }

  if (isIntelDevice(deviceName)) {
    return 'intel'
  }

  return 'unknown'
}

/**
 * Python script to detect PyTorch devices (CUDA, XPU, CPU)
 */
export const TORCH_DEVICE_DETECTION_SCRIPT = `
import torch
import sys

# Try CUDA first (NVIDIA GPUs)
try:
    if torch.cuda.is_available():
        device_count = torch.cuda.device_count()
        print("DEVICE_TYPE:CUDA")
        for i in range(device_count):
            try:
                device_name = torch.cuda.get_device_name(i)
                print(f"{i}|{device_name}")
            except Exception as e:
                print(f"{i}|Unknown CUDA Device")
        sys.exit(0)
except Exception as e:
    print(f"CUDA check error: {str(e)}", file=sys.stderr)

# Try XPU next (Intel Arc GPUs)
try:
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        device_count = torch.xpu.device_count()
        print("DEVICE_TYPE:XPU")
        for i in range(device_count):
            try:
                device_name = torch.xpu.get_device_name(i)
                print(f"{i}|{device_name}")
            except Exception as e:
                print(f"{i}|Unknown XPU Device")
        sys.exit(0)
except Exception as e:
    print(f"XPU check error: {str(e)}", file=sys.stderr)

# Fallback to CPU
print("DEVICE_TYPE:CPU")
print("0|CPU")
`

/**
 * Parse device detection output from Python script
 */
export function parseDeviceDetectionOutput(
  output: string,
  serviceName: string,
): { deviceType: DeviceType; devices: DetectedDevice[] } {
  let deviceType: DeviceType = 'XPU' // Default for backward compatibility
  const devices: DetectedDevice[] = []

  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((line) => line !== '')

  for (const line of lines) {
    if (line.startsWith('DEVICE_TYPE:')) {
      deviceType = line.split(':')[1] as DeviceType
      appLoggerInstance.info(`Detected device type: ${deviceType}`, serviceName)
      continue
    }

    const parts = line.split('|', 2)
    if (parts.length === 2) {
      const id = parts[0]
      const name = parts[1]
      devices.push({ id, name })
    }
  }

  return { deviceType, devices }
}

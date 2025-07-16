import { PythonService } from './service'

type Device = Omit<InferenceDevice, 'selected'>

export async function detectLevelZeroDevices(pythonService: PythonService): Promise<Device[]> {
  try {
    const pythonScript = `
import torch
import sys

try:
    # Try to get the number of XPU devices
    device_count = torch.xpu.device_count()
    
    # For each device, get its name and print it
    for i in range(device_count):
        try:
            device_name = torch.xpu.get_device_name(i)
            print(f"{i}|{device_name}")
        except Exception as e:
            print(f"{i}|Unknown Device")
except Exception as e:
    print(f"Error detecting XPU devices: {str(e)}")
    sys.exit(1)
`
    let allDevices: Device[] = []
    let lastDeviceList: Device[] = []
    let i = 0
    while ((lastDeviceList.length > 0 || i == 0) && i < 10) {
      // Execute the Python script
      const result = await pythonService.run(['-c', pythonScript], {
        PYTHONNOUSERSITE: 'true',
        ONEAPI_DEVICE_SELECTOR: `level_zero:${i}`,
      })

      // Parse the output
      const devices: Device[] = []
      const lines = result
        .split('\n')
        .map((l) => l.trim())
        .filter((line) => line !== '')

      for (const line of lines) {
        if (line.startsWith('Error detecting XPU devices:')) {
          console.error(line)
          continue
        }

        const parts = line.split('|', 2)
        if (parts.length == 2) {
          const id = `${i}`
          const name = parts[1]

          devices.push({ id, name })
        }
      }
      i = i + 1
      lastDeviceList = devices
      allDevices = allDevices.concat(lastDeviceList)
    }
    return allDevices
  } catch (error) {
    console.error('Error detecting level_zero devices:', error)
    return []
  }
}

/**
 * Detect available OpenVINO devices using a Python script
 * This uses the OpenVINO Core API to get the available devices and their full names
 */
export async function detectOpenVINODevices(pythonService: PythonService): Promise<Device[]> {
  try {
    // Python script to enumerate OpenVINO devices
    const pythonScript = `
import openvino
import sys

try:
    # Create OpenVINO Core instance
    core = openvino.Core()
    
    # Get available devices
    devices = core.available_devices
    
    # Get full names for each device
    device_names = [core.get_property(d, openvino.properties.device.full_name).strip() for d in devices]
    
    # Print device info in a format we can parse
    for i, (device_id, name) in enumerate(zip(devices, device_names)):
        print(f"{device_id}|{name}")
except Exception as e:
    print(f"Error detecting OpenVINO devices: {str(e)}")
    sys.exit(1)
`

    // Execute the Python script
    const result = await pythonService.run(['-c', pythonScript], { PYTHONNOUSERSITE: 'true' })

    // Parse the output
    const devices: Device[] = []
    const lines = result
      .split('\n')
      .map((l) => l.trim())
      .filter((line) => line !== '')

    for (const line of lines) {
      if (line.startsWith('Error detecting OpenVINO devices:')) {
        console.error(line)
        continue
      }

      const parts = line.split('|', 2)
      if (parts.length == 2) {
        const id = parts[0] // 'CPU', 'GPU', etc.
        if (id.includes('CPU')) continue
        const name = parts[1] // Full device name

        devices.push({
          id,
          name,
        })
      }
    }
    return devices
  } catch (error) {
    console.error('Error detecting OpenVINO devices:', error)
    return []
  }
}

export function levelZeroDeviceSelectorEnv(id?: string): { ONEAPI_DEVICE_SELECTOR: string } {
  return { ONEAPI_DEVICE_SELECTOR: `level_zero:${id ?? '*'}` }
}

export function openVinoDeviceSelectorEnv(id?: string): { OPENVINO_DEVICE: string } {
  return { OPENVINO_DEVICE: id ?? 'AUTO' }
}

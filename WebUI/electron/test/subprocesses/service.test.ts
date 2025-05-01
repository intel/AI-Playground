import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceService } from '../../subprocesses/service'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

describe('DeviceService', () => {
  let deviceService: DeviceService

  beforeEach(() => {
    vi.clearAllMocks()

    deviceService = new DeviceService()

    vi.spyOn(deviceService, 'run').mockImplementation(async () => {
      return JSON.stringify({
        device_list: [
          {
            device_id: 0,
            device_name: 'Intel(R) UHD Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:00:02.0',
            pci_device_id: '0x9a60',
            uuid: '00000000-0000-0200-0000-00019a608086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 1,
            device_name: 'Intel(R) Arc(TM) B580 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0xe20b',
            uuid: '00000000-0000-0003-0000-0000e20b8086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 2,
            device_name: 'Intel(R) Arc(TM) A770 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0x56a0',
            uuid: '00000000-0000-0003-0000-000856a08086',
            vendor_name: 'Intel(R) Corporation',
          },
        ],
      })
    })
  })

  describe('getExePath', () => {
    it('should return the correct path to xpu-smi.exe', () => {
      const exePath = deviceService.getExePath()
      expect(exePath).toContain(path.join('device-service', 'xpu-smi.exe'))
    })
  })

  describe('getBestDeviceArch', () => {
    it('should return the architecture of the best device', async () => {
      const arch = await deviceService.getBestDeviceArch()

      expect(arch).toBe('bmg')
    })

    it('should return "unknown" if device detection fails', async () => {
      vi.spyOn(deviceService, 'run').mockRejectedValue(new Error('Test error'))

      const arch = await deviceService.getBestDeviceArch()

      expect(arch).toBe('unknown')
    })
  })
})

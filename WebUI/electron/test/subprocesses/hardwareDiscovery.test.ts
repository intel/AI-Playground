import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

import { parsePowerShellGpuOutput } from '../../subprocesses/hardwareDiscovery'

describe('parsePowerShellGpuOutput', () => {
  it('should extract Intel GPU with PCI device ID from PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([
      {
        device: 'INTEL_GPU_PNP',
        name: 'Intel(R) Graphics',
        gpuDeviceId: '0xFD80',
      },
    ])
  })

  it('should filter out non-Intel GPUs', () => {
    const output = JSON.stringify([
      {
        Name: 'NVIDIA GeForce RTX 4090',
        PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_00001234&REV_A1',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should handle multiple Intel GPUs', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Arc(TM) B580 Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_00001234&REV_00',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(2)
    expect(result[0].gpuDeviceId).toBe('0xE20B')
    expect(result[1].gpuDeviceId).toBe('0xFD80')
  })

  it('should handle a single object (not array) when only one GPU exists', () => {
    const output = JSON.stringify({
      Name: 'Intel(R) Graphics',
      PNPDeviceID: 'PCI\\VEN_8086&DEV_FD81&SUBSYS_22128086&REV_01',
    })

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([
      {
        device: 'INTEL_GPU_PNP',
        name: 'Intel(R) Graphics',
        gpuDeviceId: '0xFD81',
      },
    ])
  })

  it('should skip entries with null PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Microsoft Basic Display Adapter',
        PNPDeviceID: null,
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should skip entries with non-PCI PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Microsoft Remote Display Adapter',
        PNPDeviceID: 'ROOT\\YOURDEVICE\\0000',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should return empty array when no Intel GPUs present', () => {
    const output = JSON.stringify([
      {
        Name: 'NVIDIA GeForce RTX 4090',
        PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_00001234&REV_A1',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([])
  })

  it('should uppercase the device ID hex digits', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_fd80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })
})

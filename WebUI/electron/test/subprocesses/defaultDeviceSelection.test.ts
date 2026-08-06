import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import {
  resolveDefaultDevice,
  type DetectedDevice,
} from '../../subprocesses/defaultDeviceSelection'
import type { PreferredDevice } from '../../main'

// These cases all resolve to a concrete device, so the automatic-ranking
// fallback (pickBestDeviceId, which spawns a hardware probe) is never reached —
// no mocking required. persistSettings is a no-op unless a writer is registered.

const gpu = (uuid: string | null, name: string, gpuDeviceId: string | null): PreferredDevice => ({
  name,
  gpuDeviceId,
  uuid,
})

describe('resolveDefaultDevice', () => {
  it('returns an existing persisted id unchanged', async () => {
    const devices: DetectedDevice[] = [{ id: '0', name: 'A' }]
    const id = await resolveDefaultDevice(devices, { k: '0' }, 'k', null)
    expect(id).toBe('0')
  })

  it('re-derives the current id from a persisted UUID after an enumeration reorder', async () => {
    const devices: DetectedDevice[] = [
      { id: '0', name: 'A', uuid: 'xyz' },
      { id: '1', name: 'B', uuid: 'abc' },
    ]
    // Stored id "0" is now the wrong card; the stored UUID points at id "1".
    const id = await resolveDefaultDevice(devices, { k: '0' }, 'k', null, { k: 'abc' })
    expect(id).toBe('1')
  })

  it('matches the preferred device by UUID first and persists id + uuid', async () => {
    const devices: DetectedDevice[] = [
      { id: '0', name: 'Arc A770', uuid: 'aaa' },
      { id: '1', name: 'Arc A770', uuid: 'bbb' },
    ]
    const settingsMap: Record<string, string> = {}
    const uuidMap: Record<string, string> = {}
    const id = await resolveDefaultDevice(
      devices,
      settingsMap,
      'k',
      gpu('bbb', 'Arc A770', null),
      uuidMap,
    )
    expect(id).toBe('1') // disambiguates two identically-named GPUs
    expect(settingsMap.k).toBe('1')
    expect(uuidMap.k).toBe('bbb')
  })

  it('falls back to PCI id when there is no UUID match', async () => {
    const devices: DetectedDevice[] = [
      { id: 'GPU.0', name: 'Intel', pciId: '0x1111' },
      { id: 'GPU.1', name: 'Intel', pciId: '0x56a0' },
    ]
    const id = await resolveDefaultDevice(devices, {}, 'k', gpu(null, 'Intel', '0x56a0'))
    expect(id).toBe('GPU.1')
  })

  it('falls back to name matching when neither UUID nor PCI match', async () => {
    const devices: DetectedDevice[] = [
      { id: '0', name: 'NVIDIA GeForce RTX 4070' },
      { id: '1', name: 'NVIDIA GeForce RTX 4090' },
    ]
    const id = await resolveDefaultDevice(
      devices,
      {},
      'k',
      gpu(null, 'NVIDIA GeForce RTX 4090', null),
    )
    expect(id).toBe('1')
  })
})

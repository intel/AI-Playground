import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { normalizeDeviceUuid, withSelectedDevice } from '../../subprocesses/deviceDetection'

describe('normalizeDeviceUuid', () => {
  it('lowercases and strips the NVIDIA "GPU-" prefix so cross-source UUIDs compare equal', () => {
    // nvidia-smi form vs torch get_device_properties form of the same GPU.
    expect(normalizeDeviceUuid('GPU-ABC123')).toBe('abc123')
    expect(normalizeDeviceUuid('abc123')).toBe('abc123')
    expect(normalizeDeviceUuid('GPU-ABC123')).toBe(normalizeDeviceUuid('abc123'))
  })

  it('treats blank / missing input as no UUID', () => {
    expect(normalizeDeviceUuid('')).toBeNull()
    expect(normalizeDeviceUuid('   ')).toBeNull()
    expect(normalizeDeviceUuid(null)).toBeNull()
    expect(normalizeDeviceUuid(undefined)).toBeNull()
  })
})

describe('withSelectedDevice', () => {
  const devices = [
    { id: '0', uuid: 'aaa', selected: false },
    { id: '1', uuid: 'bbb', selected: false },
    { id: '2', uuid: null, selected: false },
  ]

  it('prefers a persisted UUID even when the backend-local id shifted', () => {
    // Persisted id "0" is stale (now points at a different card); the UUID wins.
    const result = withSelectedDevice(devices, '0', undefined, 'bbb')
    expect(result.find((d) => d.selected)?.id).toBe('1')
  })

  it('falls back to the persisted id when no UUID matches', () => {
    const result = withSelectedDevice(devices, '2', undefined, 'zzz')
    expect(result.find((d) => d.selected)?.id).toBe('2')
  })

  it('falls back to pickDefault when neither UUID nor id match', () => {
    const result = withSelectedDevice(devices, undefined, (ds) => ds[1], undefined)
    expect(result.find((d) => d.selected)?.id).toBe('1')
  })

  it('marks exactly one device selected (or none when nothing resolves)', () => {
    const none = withSelectedDevice(devices, undefined, () => undefined, undefined)
    expect(none.filter((d) => d.selected)).toHaveLength(0)
    const one = withSelectedDevice(devices, '0', undefined, undefined)
    expect(one.filter((d) => d.selected)).toHaveLength(1)
  })
})

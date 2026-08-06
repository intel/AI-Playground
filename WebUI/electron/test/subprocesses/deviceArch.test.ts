import { describe, it, expect } from 'vitest'
import {
  getDeviceArch,
  getArchPriority,
  getBestDevice,
  bestNameMatch,
  categorizeDevice,
  rankDevicesByCategory,
  type ReferenceAccelerator,
} from '../../subprocesses/deviceArch'

describe('deviceArch', () => {
  describe('getDeviceArch', () => {
    it('should return the correct architecture for known device IDs', () => {
      expect(getDeviceArch(0x4f80)).toBe('acm')
      expect(getDeviceArch(0x7d40)).toBe('mtl')
      expect(getDeviceArch(0xe202)).toBe('bmg')
      expect(getDeviceArch(0xe211)).toBe('bmg') // Arc Pro B60
      expect(getDeviceArch(0xe212)).toBe('bmg') // Arc Pro B50
      expect(getDeviceArch(0xfd80)).toBe('wcl')
      expect(getDeviceArch(0xfd81)).toBe('wcl')
    })

    it('should return "unknown" for unknown device IDs', () => {
      expect(getDeviceArch(0x0000)).toBe('unknown')
      expect(getDeviceArch(0xffff)).toBe('unknown')
    })
  })

  describe('getArchPriority', () => {
    it('should return the correct priority for each architecture', () => {
      expect(getArchPriority('bmg')).toBe(5)
      expect(getArchPriority('acm')).toBe(4)
      expect(getArchPriority('arl_h')).toBe(3)
      expect(getArchPriority('wcl')).toBe(2)
      expect(getArchPriority('lnl')).toBe(2)
      expect(getArchPriority('mtl')).toBe(1)
      expect(getArchPriority('unknown')).toBe(0)
    })
  })
  describe('getBestDevice', () => {
    it('should return the id of the best device', () => {
      expect(
        getBestDevice(
          [
            { id: '0', name: 'Intel® Arc™ B580 Graphics' },
            { id: '1', name: 'Intel® Arc™ A770M Graphics' },
          ],
          'B580',
        ),
      ).toEqual('0')
      expect(
        getBestDevice(
          [
            { id: '0', name: 'Intel® Arc™ B580 Graphics' },
            { id: '1', name: 'Intel® Arc™ A770M Graphics' },
          ],
          'A770',
        ),
      ).toEqual('1')
    })
  })

  describe('categorizeDevice', () => {
    // A770 → acm (discrete), Meteor Lake iGPU → mtl (integrated)
    const reference: ReferenceAccelerator[] = [
      { vendor: 'intel', name: 'Intel(R) Arc(TM) A770 Graphics', gpuDeviceId: '0x56A0' },
      { vendor: 'intel', name: 'Intel(R) Arc(TM) Graphics', gpuDeviceId: '0x7D55' },
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', gpuDeviceId: null },
    ]

    it('classifies CPU and NPU by id/name regardless of reference', () => {
      expect(categorizeDevice({ id: 'CPU', name: 'Intel CPU' }, [])).toBe('cpu')
      expect(categorizeDevice({ id: 'NPU', name: 'Intel(R) AI Boost' }, [])).toBe('npu')
      expect(categorizeDevice({ id: '0', name: 'CPU' }, reference)).toBe('cpu')
    })

    it('classifies a discrete Intel Arc card as dgpu', () => {
      expect(
        categorizeDevice({ id: 'GPU.1', name: 'Intel(R) Arc(TM) A770 Graphics' }, reference),
      ).toBe('dgpu')
    })

    it('classifies an Arc Pro B60 (Battlemage) as dgpu, outranking the iGPU', () => {
      const withB60: ReferenceAccelerator[] = [
        { vendor: 'intel', name: 'Intel(R) Arc(TM) Pro B60 Graphics', gpuDeviceId: '0xE211' },
        { vendor: 'intel', name: 'Intel(R) Graphics', gpuDeviceId: '0x7D55' },
      ]
      expect(
        categorizeDevice({ id: 'GPU.1', name: 'Intel(R) Arc(TM) Pro B60 Graphics' }, withB60),
      ).toBe('dgpu')
      expect(categorizeDevice({ id: 'GPU.0', name: 'Intel(R) Graphics' }, withB60)).toBe('igpu')
    })

    it('classifies an integrated Intel GPU as igpu', () => {
      expect(categorizeDevice({ id: 'GPU.0', name: 'Intel(R) Arc(TM) Graphics' }, reference)).toBe(
        'igpu',
      )
    })

    it('classifies any NVIDIA GPU as dgpu', () => {
      expect(categorizeDevice({ id: '0', name: 'NVIDIA GeForce RTX 4090' }, reference)).toBe('dgpu')
    })

    it('treats an unmatched GPU as integrated (never mislabeled discrete)', () => {
      expect(categorizeDevice({ id: '0', name: 'Some Unknown GPU' }, reference)).toBe('igpu')
      expect(categorizeDevice({ id: '0', name: 'Intel Arc A770' }, [])).toBe('igpu')
    })
  })

  describe('bestNameMatch', () => {
    const devices = [
      { id: '0', name: 'Intel(R) Arc(TM) A770 Graphics' },
      { id: '1', name: 'Intel(R) Arc(TM) Graphics' },
    ]

    it('matches a device name ignoring punctuation/casing differences', () => {
      expect(bestNameMatch('Intel Arc A770 Graphics', devices)?.id).toBe('0')
    })

    it('returns undefined when nothing is a confident match', () => {
      expect(bestNameMatch('NVIDIA GeForce RTX 4090', devices)).toBeUndefined()
    })

    it('returns undefined for empty inputs', () => {
      expect(bestNameMatch('', devices)).toBeUndefined()
      expect(bestNameMatch('Intel Arc A770', [])).toBeUndefined()
    })
  })

  describe('rankDevicesByCategory', () => {
    const reference: ReferenceAccelerator[] = [
      { vendor: 'intel', name: 'Intel(R) Arc(TM) A770 Graphics', gpuDeviceId: '0x56A0' },
      { vendor: 'intel', name: 'Intel(R) Arc(TM) Graphics', gpuDeviceId: '0x7D55' },
    ]

    it('orders dGPU > iGPU > NPU > CPU', () => {
      const devices = [
        { id: 'CPU', name: 'CPU' },
        { id: 'NPU', name: 'Intel(R) AI Boost' },
        { id: 'GPU.0', name: 'Intel(R) Arc(TM) Graphics' },
        { id: 'GPU.1', name: 'Intel(R) Arc(TM) A770 Graphics' },
      ]
      expect(rankDevicesByCategory(devices, reference).map((d) => d.id)).toEqual([
        'GPU.1',
        'GPU.0',
        'NPU',
        'CPU',
      ])
    })

    it('keeps detection order for devices in the same category', () => {
      const devices = [
        { id: '0', name: 'Intel(R) Arc(TM) A770 Graphics' },
        { id: '1', name: 'Intel(R) Arc(TM) A770 Graphics' },
      ]
      expect(rankDevicesByCategory(devices, reference).map((d) => d.id)).toEqual(['0', '1'])
    })

    it('falls back to detection order when reference is empty', () => {
      const devices = [
        { id: '0', name: 'Intel(R) Arc(TM) Graphics' },
        { id: '1', name: 'Intel(R) Arc(TM) A770 Graphics' },
      ]
      // No reference → both classified igpu → first-detected wins, as before.
      expect(rankDevicesByCategory(devices, [])[0].id).toBe('0')
    })
  })
})

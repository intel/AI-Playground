import { describe, it, expect } from 'vitest'
import { getDeviceArch, getArchPriority, getBestDevice } from '../../subprocesses/deviceArch'

describe('deviceArch', () => {
  describe('getDeviceArch', () => {
    it('should return the correct architecture for known device IDs', () => {
      expect(getDeviceArch(0x4f80)).toBe('acm')
      expect(getDeviceArch(0x7d40)).toBe('mtl')
      expect(getDeviceArch(0xe202)).toBe('bmg')
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
})

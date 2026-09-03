import { describe, it, expect } from 'vitest'
import { needsMicrophonePermissionProbe, selectAudioInputDevices } from './audioDevices'

function device(overrides: Partial<MediaDeviceInfo>): MediaDeviceInfo {
  return {
    kind: 'audioinput',
    deviceId: 'id',
    groupId: 'group',
    label: 'Mic',
    toJSON: () => ({}),
    ...overrides,
  } as MediaDeviceInfo
}

describe('needsMicrophonePermissionProbe', () => {
  it('requests a probe while Chromium still withholds device ids', () => {
    const devices = [device({ deviceId: '', label: '' })]
    expect(needsMicrophonePermissionProbe(devices)).toBe(true)
  })

  it('requests a probe when ids are present but labels are still hidden', () => {
    const devices = [device({ deviceId: 'abc', label: '' })]
    expect(needsMicrophonePermissionProbe(devices)).toBe(true)
  })

  it('requests a probe when no audio input is reported at all', () => {
    const devices = [device({ kind: 'videoinput' })]
    expect(needsMicrophonePermissionProbe(devices)).toBe(true)
  })

  it('skips the probe once ids and labels are exposed', () => {
    const devices = [device({ deviceId: 'abc', label: 'JBL TUNE 310C' })]
    expect(needsMicrophonePermissionProbe(devices)).toBe(false)
  })
})

describe('selectAudioInputDevices', () => {
  it('keeps distinct devices that share an empty group id', () => {
    const devices = [
      device({ deviceId: 'mic-a', groupId: '', label: 'JBL TUNE 310C' }),
      device({ deviceId: 'mic-b', groupId: '', label: 'Webcam Mic' }),
    ]
    expect(selectAudioInputDevices(devices).map((d) => d.deviceId)).toEqual(['mic-a', 'mic-b'])
  })

  it('drops the virtual default and communications aliases', () => {
    const devices = [
      device({ deviceId: 'default' }),
      device({ deviceId: 'communications' }),
      device({ deviceId: 'mic-a' }),
    ]
    expect(selectAudioInputDevices(devices).map((d) => d.deviceId)).toEqual(['mic-a'])
  })

  it('de-duplicates repeated device ids', () => {
    const devices = [
      device({ deviceId: 'mic-a', groupId: 'g1' }),
      device({ deviceId: 'mic-a', groupId: 'g2' }),
    ]
    expect(selectAudioInputDevices(devices)).toHaveLength(1)
  })

  it('ignores non audio input kinds and entries without an id', () => {
    const devices = [
      device({ kind: 'videoinput', deviceId: 'cam' }),
      device({ kind: 'audiooutput', deviceId: 'spk' }),
      device({ deviceId: '' }),
      device({ deviceId: 'mic-a' }),
    ]
    expect(selectAudioInputDevices(devices).map((d) => d.deviceId)).toEqual(['mic-a'])
  })
})

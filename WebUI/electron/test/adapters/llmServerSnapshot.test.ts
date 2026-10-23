import { afterEach, describe, expect, it } from 'vitest'
import { llmServerMtpArmed, setLlmServiceLookup } from '../../adapters/llmServerSnapshot.ts'

describe('llmServerMtpArmed', () => {
  afterEach(() => setLlmServiceLookup(() => undefined))

  it('reads the armed flag off the live OpenVINO service', () => {
    setLlmServiceLookup((serviceName) =>
      serviceName === 'openvino-backend'
        ? { get_info: () => ({ devices: [], ovmsMtpArmed: true }) }
        : undefined,
    )
    expect(llmServerMtpArmed('openVINO')).toBe(true)
  })

  it('is false when the service is missing or the launch was not armed', () => {
    expect(llmServerMtpArmed('openVINO')).toBe(false)
    setLlmServiceLookup(() => ({ get_info: () => ({ devices: [], ovmsMtpArmed: false }) }))
    expect(llmServerMtpArmed('openVINO')).toBe(false)
  })
})

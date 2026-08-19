import { describe, expect, it } from 'vitest'
import { resolveTtsSpeakerLabel } from './ttsSpeakerLabel'

const hans = {
  name: 'Hans',
  instruct: 'Authoritative and commanding – Delivered with strict, formal authority.',
}

describe('resolveTtsSpeakerLabel', () => {
  it('uses a saved voice name in voice_design even when a leftover preset speaker is set', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'voice_design',
        voiceName: 'Hans',
        instruct: hans.instruct,
        savedVoices: [hans],
        speaker: 'Vivian',
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('Hans')
  })

  it('matches a saved voice by instruct when no name is stored (persisted selection)', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'voice_design',
        instruct: hans.instruct,
        savedVoices: [hans],
        speaker: 'Ryan',
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('Hans')
  })

  it('is case-insensitive for saved voice names', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'voice_design',
        voiceName: 'hans',
        savedVoices: [hans],
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('Hans')
  })

  it('labels unnamed voice_design as custom instead of a preset speaker', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'voice_design',
        instruct: 'A gravelly pirate voice',
        savedVoices: [hans],
        speaker: 'Vivian',
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('custom')
  })

  it('uses the preset speaker in custom_voice mode', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'custom_voice',
        speaker: 'Vivian',
        savedVoices: [hans],
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('Vivian')
  })

  it('falls back to the default preset speaker in custom_voice mode', () => {
    expect(
      resolveTtsSpeakerLabel({
        mode: 'custom_voice',
        savedVoices: [],
        defaultSpeaker: 'Ryan',
      }),
    ).toBe('Ryan')
  })
})

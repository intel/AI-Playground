import { describe, expect, it } from 'vitest'
import { voicePreviewFileName, voicePreviewSentence } from './ttsVoicePreview'

describe('voicePreviewSentence', () => {
  it('introduces the voice by name', () => {
    expect(voicePreviewSentence('Tammy')).toBe("Hi, I'm Tammy")
  })

  it('trims the name', () => {
    expect(voicePreviewSentence('  Tammy  ')).toBe("Hi, I'm Tammy")
  })

  it('still says something when the name is empty', () => {
    // Save is gated on a non-empty name, so this is only a guard — but an empty
    // sentence would be rejected by the backend rather than merely sound odd.
    expect(voicePreviewSentence('   ')).not.toBe('')
  })
})

describe('voicePreviewFileName', () => {
  it('derives a stable name from the voice name', () => {
    expect(voicePreviewFileName('Tammy')).toBe('voice_preview_tammy.wav')
  })

  it('is stable across re-saves so a voice overwrites its own preview', () => {
    expect(voicePreviewFileName('Tammy')).toBe(voicePreviewFileName('Tammy'))
  })

  it('matches the case-insensitive uniqueness of voice names', () => {
    // saveVoice() treats "tammy" and "Tammy" as the same voice, so their previews
    // must collide too — otherwise a rename-by-casing would orphan a file.
    expect(voicePreviewFileName('TAMMY')).toBe(voicePreviewFileName('tammy'))
  })

  it('collapses whitespace and drops characters a filename cannot carry', () => {
    expect(voicePreviewFileName('Aunt  Mary-Jane!')).toBe('voice_preview_aunt_mary_jane.wav')
  })

  it('falls back for a name with nothing usable in it', () => {
    expect(voicePreviewFileName('🎙️')).toBe('voice_preview_unnamed.wav')
    expect(voicePreviewFileName('')).toBe('voice_preview_unnamed.wav')
  })

  it('bounds the length so the path stays writable', () => {
    expect(voicePreviewFileName('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

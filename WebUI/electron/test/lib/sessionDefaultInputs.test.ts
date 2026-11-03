import { describe, expect, it } from 'vitest'
import {
  audioMediaType,
  decideDefaultInput,
  defaultReferenceSlots,
  pickedDefaultInput,
} from '@/lib/sessionDefaultInputs'

describe('decideDefaultInput', () => {
  it('fills on first activation once the Session has a matching artifact', () => {
    expect(decideDefaultInput(undefined, 'e1', 'activation')).toEqual({
      fill: true,
      next: { seenEntryId: 'e1', picked: false },
    })
  })

  it('does nothing while the Session has no matching artifact', () => {
    expect(decideDefaultInput(undefined, null, 'activation').fill).toBe(false)
  })

  it('fills again after each new matching artifact', () => {
    const seen = { seenEntryId: 'e1', picked: false }
    expect(decideDefaultInput(seen, 'e1', 'update').fill).toBe(false)
    expect(decideDefaultInput(seen, 'e2', 'update')).toEqual({
      fill: true,
      next: { seenEntryId: 'e2', picked: false },
    })
  })

  it('keeps a manual pick across activations until the next matching artifact', () => {
    const picked = pickedDefaultInput('e1')
    expect(decideDefaultInput(picked, 'e1', 'activation').fill).toBe(false)
    expect(decideDefaultInput(picked, 'e1', 'update').fill).toBe(false)
    expect(decideDefaultInput(picked, 'e2', 'update')).toEqual({
      fill: true,
      next: { seenEntryId: 'e2', picked: false },
    })
  })

  it('reapplies the default on activation when nothing was picked', () => {
    expect(decideDefaultInput({ seenEntryId: 'e1', picked: false }, 'e1', 'activation').fill).toBe(
      true,
    )
  })

  it('treats a pick made before the newest was known as made after it', () => {
    expect(decideDefaultInput(pickedDefaultInput(undefined), 'e1', 'activation')).toEqual({
      fill: false,
      next: { seenEntryId: 'e1', picked: true },
    })
  })

  it('lets the first artifact of a Session override a pick made while it had none', () => {
    const { next } = decideDefaultInput(pickedDefaultInput(undefined), null, 'activation')
    expect(decideDefaultInput(next, 'e1', 'update').fill).toBe(true)
  })
})

describe('defaultReferenceSlots', () => {
  it('fills every required image input', () => {
    expect(
      defaultReferenceSlots([{ value: '' }, { optional: true, value: '' }, { value: 'x' }]),
    ).toEqual([0, 2])
  })

  it('falls back to the first input when all are optional', () => {
    expect(
      defaultReferenceSlots([
        { optional: true, value: '' },
        { optional: true, value: '' },
      ]),
    ).toEqual([0])
    expect(defaultReferenceSlots([])).toEqual([])
  })
})

describe('audioMediaType', () => {
  it('names the mime type of a Session audio file', () => {
    expect(audioMediaType('tts_1.wav')).toBe('audio/wav')
    expect(audioMediaType('clip.MP3')).toBe('audio/mpeg')
    expect(audioMediaType('voice.opus')).toBe('audio/opus')
  })
})

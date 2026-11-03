/**
 * What one preset's default input knows in one Session: the newest matching
 * History Entry it has seen (undefined until it has looked) and whether the
 * user picked an input since that entry arrived.
 */
export type DefaultInputState = { seenEntryId: string | null | undefined; picked: boolean }

/** `activation`: the preset became active in the Session; `update`: the Session changed. */
export type DefaultInputTrigger = 'activation' | 'update'

export type DefaultInputDecision = { fill: boolean; next: DefaultInputState }

/**
 * Whether to fill the input with the newest matching artifact. A new artifact
 * always fills and clears a pick; activation fills unless the user picked since.
 */
export function decideDefaultInput(
  state: DefaultInputState | undefined,
  newestEntryId: string | null,
  trigger: DefaultInputTrigger,
): DefaultInputDecision {
  if (newestEntryId === null) {
    return { fill: false, next: { seenEntryId: null, picked: state?.picked ?? false } }
  }
  if (state?.picked && state.seenEntryId === undefined) {
    return { fill: false, next: { seenEntryId: newestEntryId, picked: true } }
  }
  if (!state || state.seenEntryId !== newestEntryId) {
    return { fill: true, next: { seenEntryId: newestEntryId, picked: false } }
  }
  return { fill: trigger === 'activation' && !state.picked, next: state }
}

/** The state after a manual pick, given the newest entry known when it was made. */
export function pickedDefaultInput(newestKnown: string | null | undefined): DefaultInputState {
  return { seenEntryId: newestKnown, picked: true }
}

export type ReferenceSlot = { optional?: boolean; value: unknown }

/** The image inputs a default fills: every required one, or the first when all are optional. */
export function defaultReferenceSlots(slots: ReferenceSlot[]): number[] {
  const required = slots.flatMap((slot, index) => (slot.optional === true ? [] : [index]))
  if (required.length > 0) return required
  return slots.length > 0 ? [0] : []
}

const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
}

export function audioMediaType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return AUDIO_TYPES[ext] ?? (ext ? `audio/${ext}` : 'audio/wav')
}

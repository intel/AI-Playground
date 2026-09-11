/**
 * The short spoken sample stored alongside a saved Qwen3-TTS voice.
 *
 * Creating a voice synthesizes this sentence once and keeps the WAV, so the Play
 * button on a voice card is instant playback rather than another round-trip to the
 * backend (and another model load).
 */

/** What a voice says to introduce itself. */
export function voicePreviewSentence(voiceName: string): string {
  const name = voiceName.trim()
  return name ? `Hi, I'm ${name}` : "Hi, I'm your new voice"
}

/**
 * Filename for a voice's preview WAV. Derived from the name (not the save time) so
 * re-saving a voice overwrites its own preview instead of leaving the old one
 * behind — voice names are unique case-insensitively, which is what makes this safe.
 */
export function voicePreviewFileName(voiceName: string): string {
  const slug = voiceName
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]+/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
  return `voice_preview_${slug || 'unnamed'}.wav`
}

import { describe, it, expect } from 'vitest'
import {
  buildTtsAudioFileName,
  formatTtsAudioTimestamp,
  conversationLabelForTtsFile,
} from './ttsAudioFileName'

describe('buildTtsAudioFileName', () => {
  it('includes conversation label, key slice, timestamp, and optional slug', () => {
    const name = buildTtsAudioFileName({
      conversationKey: '1719859200123',
      conversationLabel: 'Podcast intro script',
      userSlug: 'episode-01',
      now: new Date('2026-07-01T14:30:52.123Z'),
    })
    expect(name).toMatch(/^Podcast_intro_script_9859200123_/)
    expect(name).toMatch(/episode_01\.wav$/)
    expect(name.endsWith('.wav')).toBe(true)
  })

  it('formatTtsAudioTimestamp uses local components', () => {
    const d = new Date(2026, 6, 1, 9, 5, 3, 7)
    expect(formatTtsAudioTimestamp(d)).toBe('20260701_090503007')
  })

  it('conversationLabelForTtsFile prefers metadata title', () => {
    const label = conversationLabelForTtsFile({
      conversationKey: '123',
      messages: [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'hello' }],
          metadata: { conversationTitle: 'My Chat' },
        },
      ],
      threadMeta: undefined,
    })
    expect(label).toBe('My Chat')
  })
})

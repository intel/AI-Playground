import { describe, it, expect } from 'vitest'
import { currentPresetName, renamePresetKeys } from './presetRenames'

describe('currentPresetName', () => {
  it('follows a renamed preset and leaves every other name alone', () => {
    expect(currentPresetName('Game Maker')).toBe('Game Agent')
    expect(currentPresetName('Assistant')).toBe('Assistant')
  })

  it('resolves both old names of a twice-renamed preset in one hop', () => {
    expect(currentPresetName('Game Maker Quick')).toBe('Quick Coder')
    expect(currentPresetName('Game Agent Quick')).toBe('Quick Coder')
  })
})

describe('renamePresetKeys', () => {
  it('re-keys stored state, variants included', () => {
    expect(
      renamePresetKeys({
        'Game Maker': { temperature: 0.4 },
        'Game Maker Quick:Fast': { temperature: 0.9 },
        'Game Agent Quick:Slow': { temperature: 0.2 },
        Assistant: { temperature: 0.7 },
      }),
    ).toEqual({
      'Game Agent': { temperature: 0.4 },
      'Quick Coder:Fast': { temperature: 0.9 },
      'Quick Coder:Slow': { temperature: 0.2 },
      Assistant: { temperature: 0.7 },
    })
  })

  it('never overwrites state already stored under the current name', () => {
    expect(renamePresetKeys({ 'Game Maker': 'old', 'Game Agent': 'current' })).toEqual({
      'Game Agent': 'current',
    })
  })

  it('returns the same object when nothing was renamed', () => {
    const entries = { Assistant: 1 }
    expect(renamePresetKeys(entries)).toBe(entries)
  })
})

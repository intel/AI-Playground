import { describe, expect, it } from 'vitest'
import { embeddingPickerState } from '@/assets/js/embeddingModelPicker'

describe('embeddingPickerState', () => {
  const models = [
    { name: 'org/plain', type: 'llamaCPP', downloaded: true, active: true },
    { name: 'org/favorite', type: 'llamaCPP', downloaded: false, favorite: true },
    { name: 'ov/other', type: 'openVINO', downloaded: true, active: true },
  ]

  it('keeps the active backend, favorites first, and basename labels', () => {
    const state = embeddingPickerState(models, 'llamaCPP')
    expect(state.activeName).toBe('org/plain')
    expect(state.items).toEqual([
      { label: 'favorite', value: 'org/favorite', active: false },
      { label: 'plain', value: 'org/plain', active: true },
    ])
  })

  it('filters to the requested backend', () => {
    const state = embeddingPickerState(models, 'openVINO')
    expect(state.activeName).toBe('ov/other')
    expect(state.items.map((item) => item.value)).toEqual(['ov/other'])
  })
})

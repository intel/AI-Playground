import { describe, expect, it } from 'vitest'
import {
  asSent,
  blockingProblems,
  chatBagProblems,
  keepUneditedValues,
  variantProblems,
  withBag,
  withoutBag,
} from '@/lib/sessionSettings'

const available = {
  models: [{ name: 'Qwen3-9B', type: 'llamaCPP' }],
  embeddingModels: [],
  services: [{ backend: 'llamaCPP' as const, isSetUp: true }],
  cloudEnabled: false,
  cloudProviderIds: [],
  embeddingBackend: 'llamaCPP' as const,
}

const gone = {
  backend: 'llamaCPP',
  selectedModels: { llamaCPP: 'Removed-Model' },
}

describe('Session Settings repair rules', () => {
  it('never blocks on settings that came from the defaults', () => {
    const problems = chatBagProblems(gone, available)
    expect(problems).toEqual([{ field: 'model', value: 'Removed-Model' }])

    expect(blockingProblems({ values: gone, fromDefaults: true }, problems)).toEqual([])
  })

  it("blocks on a Session's own unusable settings once it has sent with them", () => {
    const bag = asSent({ values: gone, fromDefaults: true })
    expect(blockingProblems(bag, chatBagProblems(gone, available))).toEqual([
      { field: 'model', value: 'Removed-Model' },
    ])
  })

  it('reports a cloud backend that is switched off', () => {
    expect(chatBagProblems({ backend: 'cloud' }, available)).toEqual([
      { field: 'backend', value: 'cloud' },
    ])
  })

  it('reports a variant the preset no longer offers', () => {
    expect(variantProblems({ variant: 'Old', bags: {} }, ['Fast', 'Quality'])).toEqual([
      { field: 'variant', value: 'Old' },
    ])
    expect(variantProblems({ variant: 'Fast', bags: {} }, ['Fast', 'Quality'])).toEqual([])
  })

  it('keeps what the Session stored for every key the user did not change since loading', () => {
    const stored = { seed: 7, temperature: 0.7 }
    const baseline = { seed: 1, temperature: 0.7 }

    const first = keepUneditedValues(stored, { seed: 1, temperature: 0.2 }, baseline)
    expect(first.values).toEqual({ seed: 7, temperature: 0.2 })

    const back = keepUneditedValues(
      first.values,
      { seed: 1, temperature: 0.7 },
      baseline,
      first.edited,
    )
    expect(back.values).toEqual({ seed: 7, temperature: 0.7 })
  })

  it('drops a reset bag and leaves the preset’s other bags and variant', () => {
    const entry = withBag(
      withBag({ variant: 'Fast', bags: {} }, 'P:Fast', {
        values: { seed: 1 },
        fromDefaults: false,
      }),
      'P:Quality',
      { values: { seed: 2 }, fromDefaults: true },
    )

    expect(withoutBag(entry, 'P:Fast')).toEqual({
      variant: 'Fast',
      bags: { 'P:Quality': { values: { seed: 2 }, fromDefaults: true } },
    })
  })
})

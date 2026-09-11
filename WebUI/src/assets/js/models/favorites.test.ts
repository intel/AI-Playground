import { describe, expect, it } from 'vitest'
import { sortFavoritesFirst, withPreferenceFlags } from './favorites'

const model = (name: string, extra: { favorite?: boolean } = {}) => ({
  name,
  ...extra,
})

describe('sortFavoritesFirst', () => {
  it('pins favorites to the top and preserves the order within each group', () => {
    const models = [
      model('first'),
      model('fav-a', { favorite: true }),
      model('second'),
      model('fav-b', { favorite: true }),
    ]

    // Catalog order is models.json priority order, so it must survive sorting.
    expect(sortFavoritesFirst(models).map((m) => m.name)).toEqual([
      'fav-a',
      'fav-b',
      'first',
      'second',
    ])
  })
})

describe('withPreferenceFlags', () => {
  const flagsFrom = (favorites: ReadonlySet<string>) => (model: { name: string }) => ({
    favorite: favorites.has(model.name),
  })

  it('attaches the looked-up flags without touching the rest of the model', () => {
    const models = [{ name: 'a', downloaded: true }, { name: 'b' }]

    const withFlags = withPreferenceFlags(models, flagsFrom(new Set(['b'])))

    expect(withFlags).toEqual([
      { name: 'a', downloaded: true, favorite: false },
      { name: 'b', favorite: true },
    ])
  })

  it('reads through the lookup on every call', () => {
    // The bug this guards against: flags baked into a catalog snapshot that is
    // only rebuilt on refresh, so favoriting a model left every picker showing
    // the stale value. Resolving through the lookup each time is the whole point.
    const models = [{ name: 'a' }]
    const favorites = new Set<string>()
    const flagsFor = flagsFrom(favorites)

    expect(withPreferenceFlags(models, flagsFor)[0].favorite).toBe(false)
    favorites.add('a')
    expect(withPreferenceFlags(models, flagsFor)[0].favorite).toBe(true)
  })

  it('overrides any flags already on the incoming model', () => {
    const models = [{ name: 'a', favorite: true }]

    expect(withPreferenceFlags(models, flagsFrom(new Set()))).toEqual([
      { name: 'a', favorite: false },
    ])
  })
})

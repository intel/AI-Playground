// The shared favorite-marking helpers for the model pickers.
//
// This module used to carry a "hide from picker" predicate as well; hiding was
// removed with the model management redesign, so a model's only presentation
// preference left is whether it is a favorite.

export type FavoritableModel = {
  name: string
  favorite?: boolean
}

export type PreferenceFlags = {
  favorite: boolean
}

/**
 * Attach the user's `favorite` flag to a list of models.
 *
 * The flag is looked up here, at the point the list is derived, instead of being
 * stored on the catalog snapshot: a snapshot is only rebuilt by a catalog
 * refresh, so a flag written into one goes stale the moment the user toggles a
 * preference and the pickers keep showing the old value. Called from a computed
 * with a lookup that reads the preferences ref, the flags re-resolve on every
 * write with no refresh involved.
 */
export function withPreferenceFlags<T extends { name: string }>(
  models: readonly T[],
  flagsFor: (model: T) => PreferenceFlags,
): (T & PreferenceFlags)[] {
  return models.map((model) => ({ ...model, ...flagsFor(model) }))
}

/**
 * Favorites first, otherwise the incoming order (which for the chat catalog is
 * `models.json` priority order and must be preserved).
 */
export function sortFavoritesFirst<T extends FavoritableModel>(models: readonly T[]): T[] {
  const favorites = models.filter((model) => model.favorite === true)
  const rest = models.filter((model) => model.favorite !== true)
  return [...favorites, ...rest]
}

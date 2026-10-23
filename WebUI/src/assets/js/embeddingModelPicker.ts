import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { sortFavoritesFirst } from '@/assets/js/models/favorites'

export type EmbeddingPickerModel = {
  name: string
  type: string
  downloaded: boolean
  favorite?: boolean
  active?: boolean
}

export type EmbeddingPickerItem = {
  label: string
  value: string
  active: boolean
}

export function embeddingPickerState(models: readonly EmbeddingPickerModel[], backend: string) {
  const forBackend = models.filter((model) => model.type === backend)
  const activeName = forBackend.find((model) => model.active)?.name ?? ''
  const items: EmbeddingPickerItem[] = sortFavoritesFirst(forBackend).map((item) => ({
    label: item.name.split('/').at(-1) ?? item.name,
    value: item.name,
    active: item.downloaded,
  }))
  return { activeName, items }
}

export function useEmbeddingModelPicker(
  models: MaybeRefOrGetter<readonly EmbeddingPickerModel[]>,
  backend: MaybeRefOrGetter<string>,
) {
  const state = computed(() => embeddingPickerState(toValue(models), toValue(backend)))
  const activeName = computed(() => state.value.activeName)
  const items = computed(() => state.value.items)
  return { activeName, items }
}

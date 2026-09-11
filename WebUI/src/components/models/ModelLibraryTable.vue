<script setup lang="ts">
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StarIcon } from '@heroicons/vue/24/solid'
import { StarIcon as StarOutlineIcon } from '@heroicons/vue/24/outline'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import ModelRowActions from './ModelRowActions.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import {
  BACKEND_LABELS,
  formatBytes,
  formatModifiedAt,
  useCaseLabel,
  type ModelSortKey,
} from '@/assets/js/models/library'
import type { ModelEntry } from '@/assets/js/models/types'

const emit = defineEmits<{
  (e: 'edit', entry: ModelEntry): void
  (e: 'delete', entry: ModelEntry): void
}>()

const library = useModelLibrary()
const i18n = useI18N()
// `languages` is a template-only global, so the formatters called from script and
// from interpolations both read the store directly.
const locale = computed(() => ({ strings: i18n.state, tag: i18n.langName }))

// `labelKey` is the i18n key of the column header, so the header markup stays one
// interpolation instead of a per-column branch.
const sortableColumns: { key: ModelSortKey; labelKey: string }[] = [
  { key: 'size', labelKey: 'MODEL_MANAGER_COL_SIZE' },
  { key: 'modified', labelKey: 'MODEL_MANAGER_COL_MODIFIED' },
]

/** Accessible name of a per-row control, e.g. "Select <model>". */
function rowLabel(key: string, entry: ModelEntry): string {
  return (i18n.state[key] ?? '').replace('{label}', entry.label)
}

function sortIndicator(key: ModelSortKey): string {
  if (library.sort.key !== key) return ''
  return library.sort.direction === 'asc' ? ' ↑' : ' ↓'
}

/** Everything before the file name, i.e. the repository the model came from. */
function repoOf(entry: ModelEntry): string {
  const segments = entry.name.split('/')
  return segments.length > 1 ? segments.slice(0, -1).join('/') : ''
}

/** A widely-shared model can be required by a dozen presets; the full list is in the title. */
function usedBySummary(entry: ModelEntry): string {
  const [first, second, ...rest] = entry.requiredBy
  const shown = [first, second].filter(Boolean).join(', ')
  return rest.length > 0 ? `${shown} +${rest.length}` : shown
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto">
    <Table>
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead class="w-8">
            <Checkbox
              :aria-label="languages.MODEL_MANAGER_SELECT_ALL"
              :model-value="library.allVisibleSelected"
              @update:model-value="library.toggleSelectAllVisible()"
            />
          </TableHead>
          <TableHead class="w-8">
            <span class="sr-only">{{ languages.MODEL_MANAGER_COL_FAVORITE }}</span>
          </TableHead>
          <TableHead>
            <button class="hover:text-foreground" @click="library.toggleSortKey('name')">
              {{ languages.MODEL_MANAGER_COL_MODEL }}{{ sortIndicator('name') }}
            </button>
          </TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_USE_CASE }}</TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_BACKEND }}</TableHead>
          <TableHead v-for="column in sortableColumns" :key="column.key">
            <button class="hover:text-foreground" @click="library.toggleSortKey(column.key)">
              {{ languages[column.labelKey] }}{{ sortIndicator(column.key) }}
            </button>
          </TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_STATUS }}</TableHead>
          <TableHead class="w-10">
            <span class="sr-only">{{ languages.MODEL_MANAGER_COL_ACTIONS }}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="entry in library.visibleEntries" :key="entry.id">
          <TableCell>
            <Checkbox
              :aria-label="rowLabel('MODEL_MANAGER_SELECT_MODEL', entry)"
              :model-value="library.selection.has(entry.id)"
              @update:model-value="library.toggleSelected(entry.id)"
            />
          </TableCell>
          <TableCell>
            <button
              :aria-label="
                entry.favorite
                  ? `${languages.MODEL_MANAGER_ACTION_UNFAVORITE} ${entry.label}`
                  : `${languages.MODEL_MANAGER_ACTION_FAVORITE} ${entry.label}`
              "
              class="flex size-6 items-center justify-center rounded hover:bg-muted"
              @click="library.setFavorite(entry.id, !entry.favorite)"
            >
              <StarIcon v-if="entry.favorite" class="size-4 text-primary" />
              <StarOutlineIcon v-else class="size-4 text-muted-foreground" />
            </button>
          </TableCell>
          <TableCell class="max-w-[340px]">
            <div class="flex items-center gap-2">
              <span class="truncate" :title="entry.name">{{ entry.label }}</span>
              <CapabilityIcons
                v-if="entry.useCase === 'llm'"
                :model="entry.capabilities"
                icon-size="size-3.5"
              />
            </div>
            <!-- The label is only the file name, and different repos ship files
                 with the same name (two `ae.safetensors`), so the repo it came
                 from is what actually tells them apart. -->
            <span v-if="repoOf(entry)" class="block truncate text-xs text-muted-foreground">
              {{ repoOf(entry) }}
            </span>
            <span
              v-if="entry.requiredBy.length > 0"
              class="block truncate text-xs text-muted-foreground"
              :title="entry.requiredBy.join(', ')"
            >
              {{ languages.MODEL_MANAGER_USED_BY }} {{ usedBySummary(entry) }}
            </span>
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ useCaseLabel(entry.useCase, locale) }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ BACKEND_LABELS[entry.serviceBackend] }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ formatBytes(entry.sizeBytes) }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ formatModifiedAt(entry.modifiedAt, locale) }}
          </TableCell>
          <TableCell class="whitespace-nowrap">
            <span
              class="rounded border border-border px-1.5 py-0.5 text-xs"
              :class="entry.downloaded ? 'text-foreground' : 'text-muted-foreground'"
            >
              {{
                entry.downloaded
                  ? languages.MODEL_MANAGER_STATUS_ON_DISK
                  : languages.MODEL_MANAGER_STATUS_NOT_DOWNLOADED
              }}
            </span>
          </TableCell>
          <TableCell>
            <ModelRowActions
              :entry="entry"
              :read-only="library.readOnly"
              @download="library.downloadOne(entry.id)"
              @reveal="library.revealInFolder(entry.id)"
              @edit="emit('edit', entry)"
              @reset-capabilities="library.resetCapabilities(entry.id)"
              @toggle-favorite="library.setFavorite(entry.id, !entry.favorite)"
              @remove-from-list="library.removeFromList(entry.id)"
              @delete="emit('delete', entry)"
            />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <p
      v-if="library.visibleEntries.length === 0 && !library.scanning"
      class="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {{ languages.MODEL_MANAGER_NO_RESULTS }}
    </p>
  </div>
</template>

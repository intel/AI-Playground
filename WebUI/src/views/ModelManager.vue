<script setup lang="ts">
// Full-screen model library. A side modal was not an option: the sidebars are
// w-100/w-130 and this table has nine columns.
import { computed, onMounted, ref } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/solid'
import ModelLibraryToolbar from '@/components/models/ModelLibraryToolbar.vue'
import ModelLibraryTable from '@/components/models/ModelLibraryTable.vue'
import EditModelCapabilitiesDialog from '@/components/models/EditModelCapabilitiesDialog.vue'
import DeleteModelDialog from '@/components/models/DeleteModelDialog.vue'
import AddModelDialog from '@/components/models/AddModelDialog.vue'
import { Spinner } from '@/components/ui/spinner'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import { useCaseLabel as localizedUseCase, type ModelCategory } from '@/assets/js/models/library'
import type { ModelCapabilityValues, ModelEntry } from '@/assets/js/models/types'

const emit = defineEmits<{ (e: 'close'): void }>()

const library = useModelLibrary()
const i18n = useI18N()
const i18nState = i18n.state

const root = ref<HTMLElement | null>(null)
const editing = ref<ModelEntry | null>(null)
const deleting = ref<ModelEntry[] | null>(null)
const showAddModel = ref(false)

// Favorites sit next to "All" rather than among the use cases: they cut across
// all of them, and they are what a returning user looks for first.
const useCases: ModelCategory[] = ['all', 'favorites', 'llm', 'embedding', 'media', 'speech']

const useCaseLabel = (useCase: ModelCategory) => {
  if (useCase === 'all') return i18nState.MODEL_MANAGER_ALL
  if (useCase === 'favorites') return i18nState.MODEL_MANAGER_FAVORITES
  return localizedUseCase(useCase, { strings: i18nState, tag: i18n.langName })
}

// The dialog is re-created per edit, and its draft is seeded from the entry, so a
// stale row would silently edit the wrong model.
const editingEntry = computed(() =>
  editing.value ? (library.byId(editing.value.id) ?? editing.value) : null,
)

onMounted(() => {
  // The Escape handler lives on the overlay, and a plain <div> receives no key
  // events until something inside it has focus — so the overlay takes focus itself
  // the moment it opens, before anything slower gets underway.
  root.value?.focus()
  library.refresh()
})

async function saveCapabilities(capabilities: Partial<ModelCapabilityValues>) {
  if (!editing.value) return
  await library.saveCapabilities(editing.value.id, capabilities)
  editing.value = null
}

async function resetCapabilities() {
  if (!editing.value) return
  await library.resetCapabilities(editing.value.id)
  editing.value = null
}

async function confirmDelete() {
  const entries = deleting.value
  deleting.value = null
  if (entries) await library.deleteFromDisk(entries.map((entry) => entry.id))
}
</script>

<template>
  <!-- Opaque background: at 95% the chat view and settings sidebar bled through
       as ghost text behind the table. -->
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    :aria-label="languages.MODEL_MANAGER_TITLE"
    class="absolute inset-0 z-10 flex flex-col bg-background text-foreground focus:outline-none"
    @keydown.esc="emit('close')"
  >
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <div class="flex items-baseline gap-3">
        <h1 class="text-lg font-semibold">{{ languages.MODEL_MANAGER_TITLE }}</h1>
        <Spinner v-if="library.scanning || library.deleting" class="size-4" />
      </div>
      <button
        :aria-label="languages.MODEL_MANAGER_CLOSE"
        class="flex size-7 items-center justify-center rounded hover:bg-muted"
        @click="emit('close')"
      >
        <XMarkIcon class="size-5" />
      </button>
    </header>

    <p
      v-if="library.readOnly"
      class="border-b border-border bg-amber-600/10 px-4 py-2 text-sm text-amber-500"
    >
      {{ languages.MODEL_MANAGER_READ_ONLY }}
    </p>

    <div class="flex min-h-0 flex-1">
      <nav
        class="w-52 shrink-0 border-r border-border p-3"
        :aria-label="languages.MODEL_MANAGER_USE_CASE_NAV"
      >
        <ul class="flex flex-col gap-1">
          <li v-for="useCase in useCases" :key="useCase">
            <button
              class="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-sm hover:bg-muted"
              :class="
                library.filters.useCase === useCase
                  ? 'bg-muted font-medium'
                  : 'text-muted-foreground'
              "
              :aria-current="library.filters.useCase === useCase ? 'true' : undefined"
              @click="library.setFilters({ useCase })"
            >
              <span>{{ useCaseLabel(useCase) }}</span>
              <span class="text-xs text-muted-foreground">
                {{ library.useCaseCounts[useCase] || '–' }}
              </span>
            </button>
          </li>
        </ul>
      </nav>

      <div class="flex min-w-0 flex-1 flex-col">
        <ModelLibraryToolbar
          @add-model="showAddModel = true"
          @delete-selected="deleting = library.selectedDeletable"
        />
        <ModelLibraryTable
          @edit="(entry) => (editing = entry)"
          @delete="(entry) => (deleting = [entry])"
        />
      </div>
    </div>

    <EditModelCapabilitiesDialog
      v-if="editingEntry"
      :entry="editingEntry"
      @cancel="editing = null"
      @save="saveCapabilities"
      @reset="resetCapabilities"
    />

    <DeleteModelDialog
      v-if="deleting && deleting.length > 0"
      :entries="deleting"
      @cancel="deleting = null"
      @confirm="confirmDelete"
    />

    <AddModelDialog
      v-if="showAddModel"
      @close="
        () => {
          showAddModel = false
          library.refresh()
        }
      "
    />
  </div>
</template>

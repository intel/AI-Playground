<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowDownTrayIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/vue/24/solid'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import { BACKEND_LABELS, type ModelDownloadState } from '@/assets/js/models/library'
import type { CapabilityKey } from '@/assets/js/capabilities'
import type { ModelServiceBackend } from '@/assets/js/models/types'

const emit = defineEmits<{
  (e: 'add-model'): void
  (e: 'delete-selected'): void
}>()

const library = useModelLibrary()
// `languages` is a template-only global, so dropdown items built in script need
// the store directly.
const i18nState = useI18N().state

// The picker's capability row expects a Set, and toggling is additive (AND).
const activeCapabilities = computed(() => new Set(library.filters.capabilities))

function toggleCapability(key: CapabilityKey) {
  const next = new Set(library.filters.capabilities)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  library.setFilters({ capabilities: [...next] })
}

// Both dropdowns offer only what the selected category contains, and a filter
// with a single possible value is locked to it: choosing it would change nothing
// and every other choice would empty the table.
const backendItems = computed(() =>
  library.backendOptions.map((value: ModelServiceBackend) => ({
    label: BACKEND_LABELS[value],
    value,
    active: true,
  })),
)

const backendLocked = computed(() => backendItems.value.length <= 1)

// An empty category has no backend to lock onto, so it keeps the "all" entry —
// otherwise the closed dropdown would have no label to show.
const backendMenuItems = computed(() =>
  backendLocked.value && backendItems.value.length === 1
    ? backendItems.value
    : [
        { label: i18nState.MODEL_MANAGER_FILTER_ALL_BACKENDS, value: 'all', active: true },
        ...backendItems.value,
      ],
)

const backendValue = computed(() =>
  backendLocked.value ? (backendItems.value[0]?.value ?? 'all') : library.filters.backend,
)

// Resolved inside the computed, not once at setup: `i18nState` is filled in
// asynchronously and refilled on every language switch, so a label read at setup
// time would be whatever was loaded then — often nothing at all.
const STATUS_LABEL_KEYS: Record<Exclude<ModelDownloadState, 'all'>, string> = {
  downloaded: 'MODEL_MANAGER_FILTER_ON_DISK',
  notDownloaded: 'MODEL_MANAGER_FILTER_NOT_DOWNLOADED',
}

const statusItems = computed(() =>
  library.downloadStateOptions.map((value: Exclude<ModelDownloadState, 'all'>) => ({
    label: i18nState[STATUS_LABEL_KEYS[value]],
    value,
    active: true,
  })),
)

const statusLocked = computed(() => statusItems.value.length <= 1)

const statusMenuItems = computed(() =>
  statusLocked.value && statusItems.value.length === 1
    ? statusItems.value
    : [
        { label: i18nState.MODEL_MANAGER_FILTER_ALL_STATUS, value: 'all', active: true },
        ...statusItems.value,
      ],
)

const statusValue = computed(() =>
  statusLocked.value ? (statusItems.value[0]?.value ?? 'all') : library.filters.downloadState,
)
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
    <!-- The batch actions stay put and grey out rather than appearing and
         disappearing: a toolbar that reflows as rows are ticked moves the search
         field out from under the cursor. Each disabled button is wrapped in the
         tooltip trigger, because a disabled button fires no pointer events of its
         own and would otherwise never explain why it is dead. -->
    <TooltipProvider :delay-duration="200">
      <div class="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger as-child>
            <span>
              <Button
                variant="secondary"
                size="icon"
                class="size-8"
                :aria-label="languages.COM_ADD + ' ' + languages.MODEL"
                @click="emit('add-model')"
              >
                <PlusIcon class="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent class="bg-card border border-border text-foreground p-2 z-[200]">
            <p class="text-xs">{{ languages.COM_ADD + ' ' + languages.MODEL }}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <span>
              <Button
                variant="secondary"
                size="icon"
                class="size-8"
                :aria-label="languages.MODEL_MANAGER_DOWNLOAD_SELECTED"
                :disabled="library.selectedDownloadable.length === 0"
                @click="library.downloadSelected()"
              >
                <ArrowDownTrayIcon class="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent class="bg-card border border-border text-foreground p-2 z-[200]">
            <p class="text-xs">
              {{ languages.MODEL_MANAGER_DOWNLOAD_SELECTED }}
              <template v-if="library.selectedDownloadable.length > 0">
                ({{ library.selectedDownloadable.length }})
              </template>
            </p>
            <p
              v-if="library.selectedDownloadable.length === 0"
              class="text-xs text-muted-foreground"
            >
              {{ languages.MODEL_MANAGER_NEEDS_SELECTION_DOWNLOAD }}
            </p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <span>
              <Button
                variant="secondary"
                size="icon"
                class="size-8"
                :class="
                  library.selectedDeletable.length > 0
                    ? 'text-destructive hover:text-destructive'
                    : ''
                "
                :aria-label="languages.MODEL_MANAGER_DELETE_SELECTED"
                :disabled="library.selectedDeletable.length === 0"
                @click="emit('delete-selected')"
              >
                <TrashIcon class="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent class="bg-card border border-border text-foreground p-2 z-[200]">
            <p class="text-xs">
              {{ languages.MODEL_MANAGER_DELETE_SELECTED }}
              <template v-if="library.selectedDeletable.length > 0">
                ({{ library.selectedDeletable.length }})
              </template>
            </p>
            <p v-if="library.selectedDeletable.length === 0" class="text-xs text-muted-foreground">
              {{ languages.MODEL_MANAGER_NEEDS_SELECTION_DELETE }}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>

    <div
      class="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2"
    >
      <MagnifyingGlassIcon class="size-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        :aria-label="languages.MODEL_MANAGER_SEARCH"
        :placeholder="languages.MODEL_MANAGER_SEARCH"
        class="w-full bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        :value="library.filters.search"
        @input="library.setFilters({ search: ($event.target as HTMLInputElement).value })"
      />
    </div>
    <CapabilityIcons
      mode="filter"
      :active-keys="activeCapabilities"
      icon-size="size-4"
      @toggle="toggleCapability"
    />
    <!-- Grouped and named so the dropdown, whose trigger is a label-only button,
         is addressable by what it filters. -->
    <div
      role="group"
      :aria-label="languages.MODEL_MANAGER_FILTER_BACKEND"
      class="w-[150px]"
      :class="backendLocked ? 'opacity-60' : ''"
    >
      <DropDownNew
        :title="languages.MODEL_MANAGER_FILTER_BACKEND"
        :items="backendMenuItems"
        :value="backendValue"
        :disabled="backendLocked"
        @change="
          (value: string) => library.setFilters({ backend: value as ModelServiceBackend | 'all' })
        "
      />
    </div>
    <div
      role="group"
      :aria-label="languages.MODEL_MANAGER_FILTER_STATUS"
      class="w-[170px]"
      :class="statusLocked ? 'opacity-60' : ''"
    >
      <DropDownNew
        :title="languages.MODEL_MANAGER_FILTER_STATUS"
        :items="statusMenuItems"
        :value="statusValue"
        :disabled="statusLocked"
        @change="
          (value: string) => library.setFilters({ downloadState: value as ModelDownloadState })
        "
      />
    </div>
  </div>
</template>

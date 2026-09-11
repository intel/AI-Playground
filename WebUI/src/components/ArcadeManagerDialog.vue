<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ text('ARCADE_MANAGE_TITLE', 'Manage {arcade}') }}</DialogTitle>
        <DialogDescription>
          {{
            text(
              'ARCADE_MANAGE_DESCRIPTION',
              'Tick a game to show it in {arcade}. Unticking only takes it off the page — the files stay in your game folder.',
            )
          }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4 max-h-[55vh] overflow-y-auto py-1 pr-1">
        <p v-if="loading" class="text-sm text-muted-foreground">
          {{ text('ARCADE_MANAGE_LOADING', 'Reading your game library…') }}
        </p>
        <p v-else-if="entries.length === 0" class="text-sm text-muted-foreground">
          {{ text('ARCADE_MANAGE_EMPTY', 'No games yet. Build one with the Game Agent.') }}
        </p>
        <div v-for="group in groups" :key="group.kind" class="flex flex-col gap-2">
          <span class="text-xs uppercase tracking-wide text-muted-foreground">
            {{ group.label }}
          </span>
          <div
            v-for="entry in group.entries"
            :key="entry.id"
            class="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
          >
            <img
              v-if="entry.iconUrl"
              :src="entry.iconUrl"
              alt=""
              class="size-8 flex-none rounded object-cover border border-border"
            />
            <span
              v-else
              class="size-8 flex-none rounded bg-muted grid place-items-center text-base"
            >
              🎮
            </span>
            <span class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-foreground truncate">{{ entry.name }}</span>
              <span v-if="entry.createdAt" class="text-xs text-muted-foreground">
                {{ text('ARCADE_MANAGE_CREATED', 'Created {date}', { date: created(entry) }) }}
              </span>
            </span>
            <Checkbox
              :model-value="entry.shown"
              :disabled="saving"
              :aria-label="showLabel(entry)"
              @update:model-value="setShown(entry, $event === true)"
            />
          </div>
        </div>
      </div>

      <div class="flex justify-end">
        <Button variant="outline" @click="open = false">
          {{ text('ARCADE_MANAGE_DONE', 'Done') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'

const open = defineModel<boolean>('open', { required: true })

const agentMode = useAgentMode()
const errors = useErrors()
const oemBranding = useOemBranding()
const i18nState = useI18N().state

const entries = ref<ArcadeCatalogEntry[]>([])
const loading = ref(false)
const saving = ref(false)

function text(key: string, fallback: string, vars: Record<string, string> = {}): string {
  const template = i18nState[key] || fallback
  return Object.entries({ arcade: oemBranding.arcadeLabel, ...vars }).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, value),
    template,
  )
}

const groups = computed(() =>
  (
    [
      { kind: 'user' as const, label: text('ARCADE_MANAGE_YOUR_GAMES', 'Your games') },
      { kind: 'sample' as const, label: text('ARCADE_MANAGE_STARTER_GAMES', 'Starter games') },
    ] satisfies { kind: ArcadeCatalogEntry['kind']; label: string }[]
  )
    .map((group) => ({
      ...group,
      entries: entries.value.filter((entry) => entry.kind === group.kind),
    }))
    .filter((group) => group.entries.length > 0),
)

function created(entry: ArcadeCatalogEntry): string {
  return new Date(entry.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function showLabel(entry: ArcadeCatalogEntry): string {
  return text('ARCADE_MANAGE_SHOW_GAME', 'Show {game} in {arcade}', { game: entry.name })
}

async function load(): Promise<void> {
  loading.value = true
  try {
    entries.value = await window.electronAPI.games.arcadeCatalog()
  } finally {
    loading.value = false
  }
}

async function setShown(entry: ArcadeCatalogEntry, shown: boolean): Promise<void> {
  const previous = entry.shown
  entry.shown = shown
  saving.value = true
  try {
    const result = await window.electronAPI.games.setArcadeShown({
      kind: entry.kind,
      id: entry.id,
      shown,
    })
    if (!result.success) {
      entry.shown = previous
      errors.report(new Error(result.error ?? 'setArcadeShown failed'), {
        category: 'unknown',
        code: 'arcade/set-shown',
        userMessage: text('ARCADE_MANAGE_FAILED', 'Could not update {arcade}.'),
      })
      return
    }
    await agentMode.refreshCurrentGame()
  } finally {
    saving.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen) void load()
})
</script>

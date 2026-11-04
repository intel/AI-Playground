<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { CubeIcon, MusicalNoteIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { relativeTime } from '@/assets/js/store/recordRows'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { artifactsInScope } from '@/lib/artifactsInScope'
import type { ArtifactsScope } from '@/lib/sessionTabs'
import type { SessionArtifact } from '@/types/sessionIpc'

const gallery = useGallery()
const sessions = useSessions()
const sessionTabs = useSessionTabs()
const lifecycle = useSessionLifecycle()
const languages = useI18N().state

const deleting = ref<SessionArtifact | null>(null)

const SCOPES: { scope: ArtifactsScope; label: string }[] = [
  { scope: 'this-session', label: 'ARTIFACTS_THIS_SESSION' },
  { scope: 'all-sessions', label: 'ARTIFACTS_ALL_SESSIONS' },
]

const shown = computed(() =>
  artifactsInScope(gallery.artifacts, sessionTabs.artifactsScope, sessions.openSessionId),
)
const allSessions = computed(() => sessionTabs.artifactsScope === 'all-sessions')

onMounted(() => void gallery.refresh())
watch(
  () => sessions.openTurn,
  (turn, previous) => {
    if (previous && !turn) void gallery.refresh()
  },
)

function sessionTitle(artifact: SessionArtifact): string {
  return artifact.sessionTitle || languages.SESSIONS_UNTITLED
}

async function openSession(artifact: SessionArtifact) {
  await lifecycle.openSession(artifact.sessionId, 'open-from-artifacts')
}

async function confirmDelete() {
  const artifact = deleting.value
  deleting.value = null
  if (artifact) await gallery.remove(artifact)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col text-foreground">
    <header class="flex items-center gap-3 px-4 py-3">
      <div
        role="radiogroup"
        :aria-label="languages.ARTIFACTS_SCOPE"
        class="flex rounded-md border border-border p-0.5"
      >
        <button
          v-for="option in SCOPES"
          :key="option.scope"
          type="button"
          role="radio"
          :aria-checked="sessionTabs.artifactsScope === option.scope"
          class="rounded px-3 py-1 text-sm transition-colors"
          :class="
            sessionTabs.artifactsScope === option.scope
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="sessionTabs.artifactsScope = option.scope"
        >
          {{ languages[option.label] }}
        </button>
      </div>
      <Spinner v-if="gallery.loading" class="size-4" />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <p
        v-if="!gallery.loading && shown.length === 0"
        class="flex h-full items-center justify-center text-center text-muted-foreground"
      >
        {{ allSessions ? languages.ARTIFACTS_EMPTY_ALL : languages.ARTIFACTS_EMPTY_SESSION }}
      </p>
      <TooltipProvider v-else :delay-duration="200">
        <ul class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          <li
            v-for="artifact in shown"
            :key="artifact.url"
            role="group"
            :aria-label="artifact.prompt || sessionTitle(artifact)"
            class="flex flex-col overflow-hidden rounded-lg border border-border bg-muted"
          >
            <div class="flex aspect-square items-center justify-center bg-accent">
              <img
                v-if="artifact.mediaType === 'image'"
                :src="artifact.url"
                :alt="artifact.prompt"
                class="h-full w-full object-contain"
              />
              <video
                v-else-if="artifact.mediaType === 'video'"
                :src="artifact.url"
                controls
                preload="metadata"
                class="h-full w-full object-contain"
              />
              <CubeIcon
                v-else-if="artifact.mediaType === 'model3d'"
                class="size-12 text-muted-foreground"
              />
              <div v-else class="flex w-full flex-col items-center gap-3 px-3">
                <MusicalNoteIcon class="size-12 text-muted-foreground" />
                <audio :src="artifact.url" controls preload="metadata" class="w-full"></audio>
              </div>
            </div>
            <div class="flex flex-1 flex-col gap-1 px-3 py-2">
              <p class="truncate text-sm">{{ artifact.prompt || artifact.preset }}</p>
              <p class="truncate text-xs text-muted-foreground">
                <template v-if="allSessions">{{ sessionTitle(artifact) }} · </template>
                {{ relativeTime(artifact.timestamp) }}
              </p>
              <div class="mt-1 flex items-center justify-between gap-2">
                <Button
                  v-if="artifact.sessionId !== sessions.openSessionId"
                  variant="ghost"
                  size="sm"
                  class="px-2"
                  @click="openSession(artifact)"
                >
                  {{ languages.GALLERY_OPEN_SESSION }}
                </Button>
                <span v-else></span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-8 w-8"
                      :aria-label="languages.ARTIFACT_DELETE"
                      @click="deleting = artifact"
                    >
                      <TrashIcon class="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ languages.ARTIFACT_DELETE }}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </li>
        </ul>
      </TooltipProvider>
    </div>

    <DeleteArtifactDialog
      :open="deleting !== null"
      @update:open="(open) => !open && (deleting = null)"
      @confirm="confirmDelete"
    />
  </div>
</template>

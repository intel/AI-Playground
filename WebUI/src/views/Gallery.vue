<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CubeIcon, MusicalNoteIcon, TrashIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { relativeTime } from '@/assets/js/store/historyEntries'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionArtifact } from '@/types/sessionIpc'

const emit = defineEmits<{ (e: 'close'): void }>()

const gallery = useGallery()
const languages = useI18N().state

const root = ref<HTMLElement | null>(null)
const deleting = ref<SessionArtifact | null>(null)

onMounted(() => {
  root.value?.focus()
  void gallery.refresh()
})

function sessionTitle(artifact: SessionArtifact): string {
  return artifact.sessionTitle || languages.SESSIONS_UNTITLED
}

async function openSession(artifact: SessionArtifact) {
  await gallery.openSessionOf(artifact)
  emit('close')
}

async function confirmDelete() {
  const artifact = deleting.value
  deleting.value = null
  if (artifact) await gallery.remove(artifact)
}
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    :aria-label="languages.GALLERY_TITLE"
    class="absolute inset-0 z-10 flex flex-col bg-background text-foreground focus:outline-none"
    @keydown.esc="emit('close')"
  >
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <div class="flex items-baseline gap-3">
        <h1 class="text-lg font-semibold">{{ languages.GALLERY_TITLE }}</h1>
        <Spinner v-if="gallery.loading" class="size-4" />
      </div>
      <button
        :aria-label="languages.GALLERY_CLOSE"
        class="flex size-7 items-center justify-center rounded hover:bg-muted"
        @click="emit('close')"
      >
        <XMarkIcon class="size-5" />
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <p
        v-if="!gallery.loading && gallery.artifacts.length === 0"
        class="flex h-full items-center justify-center text-center text-muted-foreground"
      >
        {{ languages.GALLERY_EMPTY }}
      </p>
      <TooltipProvider v-else :delay-duration="200">
        <ul class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          <li
            v-for="artifact in gallery.artifacts"
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
              <MusicalNoteIcon v-else class="size-12 text-muted-foreground" />
            </div>
            <div class="flex flex-1 flex-col gap-1 px-3 py-2">
              <p class="truncate text-sm">{{ artifact.prompt || artifact.preset }}</p>
              <p class="truncate text-xs text-muted-foreground">
                {{ sessionTitle(artifact) }} · {{ relativeTime(artifact.timestamp) }}
              </p>
              <div class="mt-1 flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" class="px-2" @click="openSession(artifact)">
                  {{ languages.GALLERY_OPEN_SESSION }}
                </Button>
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

<template>
  <div
    class="flex items-start gap-2 rounded-lg px-3 py-2 transition cursor-pointer border-2 bg-muted hover:bg-muted/80"
    :class="active ? 'border-primary' : 'border-transparent'"
    role="button"
    :aria-label="entry.title"
    @click="emit('select')"
  >
    <!-- Canvas media: the output itself is the row's identity. -->
    <div
      v-if="entry.kind === 'media'"
      class="relative w-[120px] h-[72px] flex-none overflow-hidden rounded-sm flex items-center justify-center bg-background"
      draggable="true"
      @dragstart="startDrag"
    >
      <video
        v-if="isVideo(entry.media)"
        :src="entry.media.videoUrl"
        class="w-full h-full object-cover"
      />
      <Model3DViewer
        v-else-if="is3D(entry.media)"
        :src="entry.media.model3dUrl"
        class="w-full h-full"
      />
      <img
        v-else-if="mediaReady"
        :src="entry.media.imageUrl"
        alt=""
        class="w-full h-full object-cover"
      />
      <div
        v-if="entry.media.state === 'generating' || !mediaReady"
        class="absolute inset-0 bg-background/40 backdrop-blur-[1px] flex items-center justify-center"
      >
        <Spinner class="w-5 h-5 text-primary" />
      </div>
      <div v-if="nsfwBlocked" class="absolute inset-0 flex items-center justify-center bg-black/80">
        <span class="text-white text-xs font-medium text-center px-1">NSFW Blocked</span>
      </div>
      <div
        v-else-if="entry.media.type === 'image' && entry.media.fromImageGen"
        class="absolute bottom-0 w-full bg-background/60 text-foreground text-[14px] text-center py-[2px]"
      >
        {{ languages.ENHANCE_PREVIEW_BEFORE_PROCESS }}
      </div>
    </div>

    <div class="flex flex-col min-w-0 flex-1 gap-1">
      <span class="flex items-center gap-1.5 min-w-0">
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="inline-flex flex-none cursor-help" :aria-label="label">
              <img
                v-if="presetImage"
                :src="presetImage"
                :alt="label"
                class="size-5 rounded object-cover border border-border"
              />
              <span
                v-else
                class="size-5 rounded border border-border bg-muted grid place-items-center text-[10px] font-medium"
              >
                {{ label.slice(0, 1) }}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ label }}</TooltipContent>
        </Tooltip>
        <span class="truncate text-sm text-foreground">{{ entry.title }}</span>
      </span>

      <div class="flex items-center gap-2 min-w-0">
        <!-- A draft's timestamp is when its bucket was minted, not activity. -->
        <span class="text-xs text-muted-foreground shrink-0">{{
          isDraft ? 'Draft' : relativeTime(entry.updatedAt)
        }}</span>
        <!-- Where the work lives: the agent's folder, the workflow behind an output. -->
        <span v-if="entry.kind === 'agent'" class="ml-auto min-w-0 max-w-[60%]">
          <Tooltip>
            <TooltipTrigger as-child>
              <span
                class="inline-flex items-center justify-end gap-1 min-w-0 w-full cursor-help text-xs text-muted-foreground"
                :aria-label="entry.workspaceDir"
              >
                <PuzzlePieceIcon v-if="path.collapsed" class="size-3.5 flex-none" />
                <span class="truncate">{{ path.rest }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent class="max-w-xs break-all">{{ entry.workspaceDir }}</TooltipContent>
          </Tooltip>
        </span>
        <span
          v-else-if="entry.kind === 'media' && mediaPreset"
          class="ml-auto truncate text-xs text-muted-foreground"
          >{{ mediaPreset }}</span
        >
      </div>

      <ThumbnailPreviewStrip v-if="entry.kind !== 'media'" :items="thumbnails" />
    </div>

    <DropdownMenu :open="menuOpen" @update:open="(open) => (menuOpen = open)">
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6 flex-none"
          :aria-label="`${entry.title} options`"
          @click.stop
        >
          <span class="svg-icon i-dots-vertical w-4 h-4"></span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        class="w-28"
        :onCloseAutoFocus="(event) => event.preventDefault?.()"
      >
        <Dialog v-model:open="renameOpen" @update:open="(open) => !open && (menuOpen = false)">
          <DialogTrigger v-if="renamable" asChild>
            <DropdownMenuItem
              @select="
                (event: Event) => {
                  event.preventDefault()
                  renameTitle = entry.title
                }
              "
            >
              Rename
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogContent @click.stop>
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>Set a new title for this conversation.</DialogDescription>
            </DialogHeader>
            <div class="mt-2">
              <Input
                autofocus
                type="text"
                placeholder="Enter title"
                v-model="renameTitle"
                @keydown.enter.prevent="saveRename"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" @click="renameOpen = false">Cancel</Button>
              <Button :disabled="!renameTitle.trim()" @click="saveRename">Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <DropdownMenuItem @select="(event: Event) => event.preventDefault()">
              {{ entry.kind === 'media' ? languages.COM_REMOVE : 'Delete' }}
            </DropdownMenuItem>
          </AlertDialogTrigger>
          <AlertDialogContent @click.stop>
            <AlertDialogHeader>
              <AlertDialogTitle>{{ deleteCopy.title }}</AlertDialogTitle>
              <AlertDialogDescription>{{ deleteCopy.body }}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel @click.stop>Cancel</AlertDialogCancel>
              <AlertDialogAction @click.stop="emit('delete')">
                {{ languages.COM_DELETE }}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { PuzzlePieceIcon } from '@heroicons/vue/24/outline'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import Model3DViewer from '@/components/Model3DViewer.vue'
import ThumbnailPreviewStrip from '@/components/ThumbnailPreviewStrip.vue'
import { hasDisplayableMedia, is3D, isVideo } from '@/assets/js/store/imageGenerationPresets'
import { collapseGamesPrefix } from '@/assets/js/store/agentModeSessions'
import {
  isEmptyDraft,
  mediaSettings,
  relativeTime,
  toolMedia,
  type HistoryEntry,
} from '@/assets/js/store/historyEntries'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresets } from '@/assets/js/store/presets'
import { useI18N } from '@/assets/js/store/i18n'
import { checkIfNsfwBlocked, mapModeToLabel } from '@/lib/utils'

const props = defineProps<{
  entry: HistoryEntry
  active: boolean
  renamable: boolean
}>()

const emit = defineEmits<{
  select: []
  delete: []
  rename: [title: string]
}>()

const presetsStore = usePresets()
const oemBranding = useOemBranding()
const i18nState = useI18N().state

const menuOpen = ref(false)
const renameOpen = ref(false)
const renameTitle = ref('')

const isDraft = computed(() => isEmptyDraft(props.entry))

const label = computed(() =>
  props.entry.presetName
    ? oemBranding.presetLabel(props.entry.presetName)
    : mapModeToLabel(props.entry.mode),
)

const presetImage = computed(
  () => presetsStore.presets.find((preset) => preset.name === props.entry.presetName)?.image,
)

const path = computed(() =>
  props.entry.kind === 'agent'
    ? collapseGamesPrefix(props.entry.workspaceDir)
    : { collapsed: false, rest: '' },
)

const mediaPreset = computed(() => {
  if (props.entry.kind !== 'media') return ''
  const { preset, variant } = mediaSettings(props.entry.media)
  if (!preset) return ''
  return variant ? `${preset} - ${variant}` : preset
})

const mediaReady = computed(
  () => props.entry.kind === 'media' && hasDisplayableMedia(props.entry.media),
)

const thumbnails = computed(() => {
  if (props.entry.kind === 'media') return []
  return toolMedia(props.entry.messages)
    .filter((item) => item.kind === 'image')
    .map((item, index) => ({ id: `${index}-${item.url}`, imageUrl: item.url }))
})

// Cached on the item after the first look, so scrolling the list does not
// re-decode every generated image.
const nsfwBlocked = ref(false)
watchEffect(async () => {
  const entry = props.entry
  if (entry.kind !== 'media' || entry.media.type !== 'image' || entry.media.state !== 'done') return
  if (entry.media.isNsfwBlocked !== undefined) {
    nsfwBlocked.value = entry.media.isNsfwBlocked
    return
  }
  const blocked = await checkIfNsfwBlocked(entry.media.imageUrl)
  entry.media.isNsfwBlocked = blocked
  nsfwBlocked.value = blocked
})

const deleteCopy = computed(() => {
  switch (props.entry.kind) {
    case 'agent':
      return {
        title: 'Delete session?',
        body:
          "This permanently removes the conversation transcript and the agent's saved session " +
          'context. Files in the workspace folder are not touched.',
      }
    case 'media':
      return {
        title: i18nState.COM_DELETE_IMAGE_QUESTION,
        body: i18nState.COM_DELETE_IMAGE_EXPLANATION,
      }
    default:
      return {
        title: 'Delete conversation?',
        body: 'This will permanently remove this conversation and its messages.',
      }
  }
})

function saveRename() {
  const title = renameTitle.value.trim()
  if (!title) return
  emit('rename', title)
  renameOpen.value = false
  menuOpen.value = false
}

function startDrag(event: DragEvent) {
  if (props.entry.kind !== 'media') return
  event.preventDefault()
  const item = props.entry.media
  const url = isVideo(item) ? item.videoUrl : is3D(item) ? item.model3dUrl : item.imageUrl
  if (url) window.electronAPI.startDrag(url)
}
</script>

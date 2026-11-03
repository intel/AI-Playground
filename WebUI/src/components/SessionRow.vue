<template>
  <div
    class="flex items-start gap-2 rounded-lg px-3 py-2 transition cursor-pointer border-2 bg-muted hover:bg-muted/80"
    :class="active ? 'border-primary' : 'border-transparent'"
    role="button"
    tabindex="0"
    :aria-label="title"
    :aria-current="active ? 'true' : undefined"
    @click="emit('open')"
    @keydown.enter.self="emit('open')"
  >
    <div class="flex flex-col min-w-0 flex-1 gap-1">
      <span class="flex items-center gap-1.5 min-w-0">
        <span class="truncate text-sm text-foreground">{{ title }}</span>
        <Tooltip v-if="marker">
          <TooltipTrigger as-child>
            <span
              role="img"
              :aria-label="marker.label"
              class="ml-auto inline-flex flex-none items-center gap-0.5 text-xs cursor-help"
            >
              <Spinner
                v-if="marker.status === 'running'"
                class="size-3.5 text-primary"
                aria-hidden="true"
              />
              <template v-else-if="marker.status === 'queued'">
                <ClockIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span v-if="marker.short" class="text-muted-foreground" aria-hidden="true">{{
                  marker.short
                }}</span>
              </template>
              <template v-else-if="marker.status === 'downloading'">
                <ArrowDownTrayIcon class="size-3.5 text-primary" aria-hidden="true" />
                <span v-if="marker.short" class="text-muted-foreground" aria-hidden="true">{{
                  marker.short
                }}</span>
              </template>
              <template v-else-if="marker.status === 'paused'">
                <HandRaisedIcon class="size-3.5 text-amber-500" aria-hidden="true" />
                <span v-if="marker.short" class="text-amber-500" aria-hidden="true">{{
                  marker.short
                }}</span>
              </template>
              <span
                v-else
                class="size-2 rounded-full"
                :class="marker.status === 'unseenFailed' ? 'bg-red-500' : 'bg-primary'"
                aria-hidden="true"
              ></span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ marker.label }}</TooltipContent>
        </Tooltip>
      </span>
      <span class="flex items-center gap-2 min-w-0">
        <span class="text-xs text-muted-foreground shrink-0">{{
          relativeTime(session.updatedAt)
        }}</span>
        <span
          v-if="presetIcons.length > 0"
          role="list"
          :aria-label="languages.SESSIONS_PRESETS_USED"
          class="ml-auto flex items-center gap-0.5 min-w-0 overflow-hidden"
        >
          <Tooltip v-for="preset in presetIcons" :key="preset.name">
            <TooltipTrigger as-child>
              <span role="listitem" :aria-label="preset.label" class="inline-flex flex-none">
                <img
                  v-if="preset.image"
                  :src="preset.image"
                  alt=""
                  class="size-4 rounded object-cover border border-border"
                />
                <span
                  v-else
                  class="size-4 rounded border border-border bg-background grid place-items-center text-[9px] font-medium"
                  aria-hidden="true"
                >
                  {{ preset.label.slice(0, 1) }}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{{ preset.label }}</TooltipContent>
          </Tooltip>
        </span>
      </span>
    </div>

    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6 flex-none"
          :aria-label="languages.SESSIONS_OPTIONS.replace('{title}', title)"
          @click.stop
        >
          <EllipsisVerticalIcon class="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        class="w-28"
        :onCloseAutoFocus="(event) => event.preventDefault?.()"
      >
        <Dialog v-model:open="renameOpen" @update:open="(open) => !open && (menuOpen = false)">
          <DialogTrigger as-child>
            <DropdownMenuItem
              @select="
                (event: Event) => {
                  event.preventDefault()
                  renameTitle = session.title
                }
              "
            >
              {{ languages.SESSIONS_RENAME }}
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogContent @click.stop>
            <DialogHeader>
              <DialogTitle>{{ languages.SESSIONS_RENAME_TITLE }}</DialogTitle>
              <DialogDescription>{{ languages.SESSIONS_RENAME_DESCRIPTION }}</DialogDescription>
            </DialogHeader>
            <div class="mt-2">
              <Input
                autofocus
                type="text"
                :placeholder="languages.SESSIONS_RENAME_PLACEHOLDER"
                v-model="renameTitle"
                @keydown.enter.prevent="saveRename"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" @click="renameOpen = false">{{
                languages.COM_CANCEL
              }}</Button>
              <Button :disabled="!renameTitle.trim()" @click="saveRename">{{
                languages.SESSIONS_SAVE
              }}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <DropdownMenuItem @select="(event: Event) => event.preventDefault()">
              {{ languages.COM_DELETE }}
            </DropdownMenuItem>
          </AlertDialogTrigger>
          <AlertDialogContent @click.stop>
            <AlertDialogHeader>
              <AlertDialogTitle>{{ languages.SESSIONS_DELETE_TITLE }}</AlertDialogTitle>
              <AlertDialogDescription>{{ languages.SESSIONS_DELETE_BODY }}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel @click.stop>{{ languages.COM_CANCEL }}</AlertDialogCancel>
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
import { computed, ref } from 'vue'
import {
  ArrowDownTrayIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  HandRaisedIcon,
} from '@heroicons/vue/24/outline'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresets } from '@/assets/js/store/presets'
import { relativeTime } from '@/assets/js/store/historyEntries'
import { sessionRowMarker, type SessionRowStatus } from '@/lib/sessionRowStatus'
import type { SessionSummary } from '@/types/sessionIpc'

const props = defineProps<{
  session: SessionSummary
  active: boolean
  status: SessionRowStatus
}>()

const emit = defineEmits<{
  open: []
  rename: [title: string]
  delete: []
}>()

const i18n = useI18N()
const i18nState = i18n.state
const presetsStore = usePresets()
const oemBranding = useOemBranding()

const menuOpen = ref(false)
const renameOpen = ref(false)
const renameTitle = ref('')

const title = computed(() => props.session.title || i18nState.SESSIONS_UNTITLED)

const marker = computed(() => sessionRowMarker(props.status, i18nState, i18n.langName))

const presetIcons = computed(() =>
  props.session.presetsUsed.map((name) => ({
    name,
    label: oemBranding.presetLabel(name),
    image: presetsStore.presets.find((preset) => preset.name === name)?.image,
  })),
)

function saveRename() {
  const next = renameTitle.value.trim()
  if (!next) return
  emit('rename', next)
  renameOpen.value = false
  menuOpen.value = false
}
</script>

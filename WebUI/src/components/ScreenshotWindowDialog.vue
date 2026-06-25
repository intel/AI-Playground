<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-[640px]">
      <DialogHeader>
        <DialogTitle>Select a window to capture</DialogTitle>
      </DialogHeader>

      <p class="text-xs text-muted-foreground">
        The screenshot tool can only capture the window you select here. Pick the application window
        you want the assistant to be able to see.
      </p>

      <div
        v-if="permissionMissing"
        class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      >
        <p>
          macOS needs Screen Recording permission before windows can be captured. Enable AI
          Playground (or Electron in development) under Privacy &amp; Security → Screen Recording,
          then fully quit and restart the app.
        </p>
        <Button
          variant="secondary"
          size="sm"
          class="self-start px-2 py-1 text-xs"
          @click="openSettings"
        >
          Open Screen Recording settings
        </Button>
      </div>

      <div class="flex justify-end">
        <Button variant="link" size="sm" class="px-0 text-muted-foreground gap-1" @click="refresh">
          <span class="svg-icon i-refresh w-4 h-4 shrink-0" />
          Refresh
        </Button>
      </div>

      <div v-if="loading" class="py-8 text-center text-sm text-muted-foreground">
        Loading windows…
      </div>
      <div v-else-if="errorMessage" class="flex flex-col gap-2 py-4">
        <p class="text-sm text-destructive">{{ errorMessage }}</p>
        <Button
          v-if="isMac"
          variant="secondary"
          size="sm"
          class="self-start px-2 py-1 text-xs"
          @click="openSettings"
        >
          Open Screen Recording settings
        </Button>
      </div>
      <div v-else-if="windows.length === 0" class="py-8 text-center text-sm text-muted-foreground">
        No open windows found.
      </div>
      <div v-else class="grid grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto pr-1">
        <button
          v-for="win in windows"
          :key="win.id"
          type="button"
          class="flex flex-col gap-2 rounded-md border border-border p-2 text-left hover:border-primary focus:border-primary focus:outline-none"
          :class="{ 'border-primary ring-1 ring-primary': win.id === selectedId }"
          @click="select(win)"
        >
          <div class="aspect-video w-full overflow-hidden rounded bg-muted">
            <img
              v-if="win.thumbnailDataUrl"
              :src="win.thumbnailDataUrl"
              :alt="win.name"
              class="h-full w-full object-contain"
            />
          </div>
          <span class="truncate text-xs text-foreground" :title="win.name">{{ win.name }}</span>
        </button>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <Button variant="outline" @click="handleClose">Cancel</Button>
        <Button :disabled="!selectedId" @click="confirmSelection">Use this window</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTextInference } from '@/assets/js/store/textInference'
import * as toast from '@/assets/js/toast'

const props = defineProps<{ open: boolean }>()
const emits = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const textInference = useTextInference()

const windows = ref<ScreenshotWindowSource[]>([])
const loading = ref(false)
const errorMessage = ref('')
const selectedId = ref<string | null>(null)
const isMac = ref(false)
const permissionStatus = ref<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>(
  'granted',
)

const permissionMissing = computed(() => isMac.value && permissionStatus.value !== 'granted')

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emits('update:open', value),
})

function openSettings() {
  window.electronAPI.screenshot.openPermissionSettings()
}

async function refresh() {
  loading.value = true
  errorMessage.value = ''
  try {
    const permission = await window.electronAPI.screenshot.getPermissionStatus()
    isMac.value = permission.platform === 'darwin'
    permissionStatus.value = permission.status
    windows.value = await window.electronAPI.screenshot.listWindows()
    // Pre-select the currently bound window if it is still present.
    const current = textInference.screenshotWindow
    selectedId.value = current && windows.value.some((w) => w.id === current.id) ? current.id : null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to list windows'
  } finally {
    loading.value = false
  }
}

function select(win: ScreenshotWindowSource) {
  selectedId.value = win.id
}

function confirmSelection() {
  const win = windows.value.find((w) => w.id === selectedId.value)
  if (!win) return
  textInference.screenshotWindow = { id: win.id, name: win.name }
  textInference.setBuiltinToolEnabled('captureScreenshot', true)
  toast.success(`Screenshot tool bound to "${win.name}"`)
  emits('update:open', false)
}

function handleClose() {
  emits('update:open', false)
}

watch(
  () => props.open,
  (isOpenNow) => {
    if (isOpenNow) refresh()
  },
)
</script>

<template>
  <div class="flex flex-col gap-3 border border-border rounded-md p-3 mr-4">
    <div v-for="builtinTool in builtinTools" :key="builtinTool.name" class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-3">
        <div class="flex flex-col">
          <Label class="whitespace-nowrap">{{ builtinTool.label }}</Label>
          <span class="text-xs text-muted-foreground">{{ builtinTool.description }}</span>
        </div>
        <Checkbox
          :id="`builtin-tool-${builtinTool.name}`"
          :disabled="!textInference.aipgToolsEnabled"
          :model-value="textInference.isBuiltinToolEnabled(builtinTool.name)"
          @click="toggle(builtinTool.name)"
        />
      </div>

      <!-- Screenshot tool: bind to a single window -->
      <div v-if="builtinTool.name === 'captureScreenshot'" class="flex flex-col gap-1.5 pl-1 pt-1">
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">Window:</span>
          <span class="text-xs text-foreground truncate max-w-[220px]" :title="boundWindowName">
            {{ boundWindowName }}
          </span>
          <Button
            variant="secondary"
            size="sm"
            class="px-2 py-1 rounded text-xs"
            :disabled="!textInference.aipgToolsEnabled"
            @click="showWindowDialog = true"
          >
            {{ textInference.screenshotWindow ? 'Change window…' : 'Select window…' }}
          </Button>
        </div>
        <p
          v-if="textInference.isBuiltinToolEnabled('captureScreenshot') && !modelSupportsVision"
          class="text-xs text-amber-600 dark:text-amber-300"
        >
          The selected model does not support vision, so the assistant cannot use screenshots.
          Choose a vision-capable model to enable this tool.
        </p>
      </div>
    </div>

    <ScreenshotWindowDialog v-model:open="showWindowDialog" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import ScreenshotWindowDialog from '@/components/ScreenshotWindowDialog.vue'
import { useTextInference } from '@/assets/js/store/textInference'

const textInference = useTextInference()
const showWindowDialog = ref(false)

// User-facing descriptors for the built-in (internal) tools. Keys must match the
// tool names registered in `aipgTools`.
const builtinTools: Array<{ name: string; label: string; description: string }> = [
  {
    name: 'comfyUI',
    label: 'Generate media',
    description: 'Create images, videos, or 3D models from text prompts.',
  },
  {
    name: 'comfyUiImageEdit',
    label: 'Edit images',
    description: 'Edit, upscale, colorize, or transform existing images.',
  },
  {
    name: 'visualizeObjectDetections',
    label: 'Visualize detections',
    description: 'Draw bounding boxes and labels on a detected image.',
  },
  {
    name: 'captureScreenshot',
    label: 'Capture screenshot',
    description:
      'Let the assistant capture a single user-selected window to visually debug other apps.',
  },
  {
    name: 'browseWeb',
    label: 'Browse the web',
    description:
      'Let the assistant open web pages in a background browser and read their content.',
  },
]

const modelSupportsVision = computed(() => textInference.modelSupportsVision)

const boundWindowName = computed(() => textInference.screenshotWindow?.name ?? 'None selected')

function toggle(toolName: string) {
  if (!textInference.aipgToolsEnabled) return
  textInference.setBuiltinToolEnabled(toolName, !textInference.isBuiltinToolEnabled(toolName))
}
</script>

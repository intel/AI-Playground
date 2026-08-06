<template>
  <TooltipProvider>
    <div class="flex flex-col gap-3 border border-border rounded-md p-3 mr-4">
      <Collapsible
        v-for="builtinTool in builtinTools"
        :key="builtinTool.name"
        :open="isToolActive(builtinTool.name) && openTools[builtinTool.name] === true"
        class="flex flex-col gap-1.5"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1.5 min-w-0">
            <Label class="whitespace-nowrap">{{ builtinTool.label }}</Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm">
                {{ builtinTool.description }}
              </TooltipContent>
            </Tooltip>
          </div>

          <div class="flex items-center gap-3">
            <!-- Collapsed summary: n/m presets enabled. Greyed out (inactive)
                 and non-expandable while the tool is disabled. -->
            <CollapsibleTrigger
              v-if="presetsForTool(builtinTool.name).length"
              :disabled="!isToolActive(builtinTool.name)"
              class="flex items-center gap-1.5 text-xs"
              :class="
                isToolActive(builtinTool.name)
                  ? 'text-muted-foreground cursor-pointer'
                  : 'text-muted-foreground opacity-50 cursor-not-allowed'
              "
              @click="openTools[builtinTool.name] = !openTools[builtinTool.name]"
            >
              <span class="whitespace-nowrap">
                {{ enabledCount(builtinTool.name).enabled }}/{{
                  enabledCount(builtinTool.name).total
                }}
                enabled
              </span>
              <ChevronDownIcon
                class="size-4 transition-transform"
                :class="{
                  'rotate-180': isToolActive(builtinTool.name) && openTools[builtinTool.name],
                }"
              />
            </CollapsibleTrigger>
            <Checkbox
              :id="`builtin-tool-${builtinTool.name}`"
              :disabled="!textInference.aipgToolsEnabled"
              :model-value="textInference.isBuiltinToolEnabled(builtinTool.name)"
              @click="toggle(builtinTool.name)"
            />
          </div>
        </div>

        <!-- Preset-backed tools: workflows grouped by output media type (with a
             sub-heading + divider per group) so the list mirrors the per-media
             defaults. Collapsed by default and hidden while the tool is inactive. -->
        <CollapsibleContent
          v-if="presetsForTool(builtinTool.name).length"
          class="flex flex-col gap-1.5 pl-4 pt-1"
        >
          <div
            v-for="(group, groupIdx) in groupedPresetsForTool(builtinTool.name)"
            :key="group.mediaType"
            class="flex flex-col gap-1.5"
            :class="{ 'mt-1 pt-2 border-t border-border': groupIdx > 0 }"
          >
            <span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {{ group.label }}
            </span>
            <div
              v-for="workflow in group.workflows"
              :key="workflow.name"
              class="flex items-center justify-between gap-3"
            >
              <div class="flex items-center gap-2 min-w-0">
                <!-- Enable toggle in front; the name is also clickable to toggle. -->
                <Switch
                  :id="`builtin-tool-${builtinTool.name}-preset-${workflow.name}`"
                  :disabled="
                    !textInference.aipgToolsEnabled ||
                    !textInference.isBuiltinToolEnabled(builtinTool.name)
                  "
                  :model-value="textInference.isWorkflowPresetEnabled(workflow.name)"
                  @update:model-value="toggleWorkflow(builtinTool.name, workflow.name)"
                />
                <button
                  type="button"
                  :disabled="
                    !textInference.aipgToolsEnabled ||
                    !textInference.isBuiltinToolEnabled(builtinTool.name)
                  "
                  class="text-xs text-foreground truncate text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  @click="toggleWorkflow(builtinTool.name, workflow.name)"
                >
                  {{ workflow.name }}
                </button>
                <Tooltip v-if="workflow.description">
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-3.5 h-3.5 shrink-0 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="right" class="max-w-[300px] text-sm">
                    {{ workflow.description }}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <!-- Default selector: one per (tool, media type) slot. Only shown
                     when the slot has more than one workflow (a real choice). -->
                <Tooltip v-if="slotHasChoice(builtinTool.name, workflow)">
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="isDefaultWorkflow(builtinTool.name, workflow)"
                      :disabled="
                        !isToolActive(builtinTool.name) ||
                        !textInference.isWorkflowPresetEnabled(workflow.name)
                      "
                      class="flex items-center gap-1.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                      @click="chooseDefault(builtinTool.name, workflow)"
                    >
                      <span
                        v-if="isDefaultWorkflow(builtinTool.name, workflow)"
                        class="text-[11px] font-medium text-primary"
                      >
                        default
                      </span>
                      <span
                        class="flex items-center justify-center w-4 h-4 rounded-full border border-border"
                      >
                        <span
                          v-if="isDefaultWorkflow(builtinTool.name, workflow)"
                          class="w-2 h-2 rounded-full bg-primary"
                        />
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" class="text-sm">
                    Default for {{ mediaTypeLabel(workflow.mediaType) }} requests
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </CollapsibleContent>
        <!-- Screenshot tool: bind to a single window -->
        <div
          v-if="builtinTool.name === 'captureScreenshot'"
          class="flex flex-col gap-1.5 pl-1 pt-1"
        >
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
      </Collapsible>

      <ScreenshotWindowDialog v-model:open="showWindowDialog" />
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ScreenshotWindowDialog from '@/components/ScreenshotWindowDialog.vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { usePresets, type Preset } from '@/assets/js/store/presets'

const textInference = useTextInference()
const presets = usePresets()
const showWindowDialog = ref(false)

// Per-tool expand/collapse state for the preset lists. Collapsed by default.
const openTools = ref<Record<string, boolean>>({})

// A tool is "active" (interactive, expandable) only when both the master tools
// toggle and the tool's own checkbox are on. Inactive tools stay collapsed with
// a greyed-out summary.
function isToolActive(toolName: string): boolean {
  return textInference.aipgToolsEnabled && textInference.isBuiltinToolEnabled(toolName)
}

// Count of enabled workflows vs. total for the collapsed "n/m enabled" summary.
function enabledCount(toolName: string): { enabled: number; total: number } {
  const workflows = presetsForTool(toolName)
  const enabled = workflows.filter((w) => textInference.isWorkflowPresetEnabled(w.name)).length
  return { enabled, total: workflows.length }
}

// Which preset tool categories each preset-backed built-in tool exposes. Tools
// not listed here have no per-workflow sub-checkboxes.
const toolWorkflowCategories: Record<string, string[]> = {
  comfyUI: ['create-images', 'create-videos'],
  comfyUiImageEdit: ['edit-images'],
}

type ToolWorkflow = { name: string; mediaType?: string; description?: string }

// All workflows (ComfyUI presets) for a tool, regardless of enablement, so
// disabled ones stay visible and can be re-enabled. Reactive to the presets store.
function presetsForTool(toolName: string): ToolWorkflow[] {
  const categories = toolWorkflowCategories[toolName]
  if (!categories) return []
  return presets.presets
    .filter(
      (p: Preset) =>
        p.type === 'comfy' &&
        p.backend === 'comfyui' &&
        !!p.toolCategory &&
        categories.includes(p.toolCategory),
    )
    .map((p: Preset) => ({
      name: p.name,
      mediaType: p.mediaType,
      description: p.description,
    }))
}

// --- Per (tool, media type) default preset selection -------------------------

// Normalized output media type for a workflow (presets without an explicit
// mediaType produce images).
function normalizedMediaType(workflow: ToolWorkflow): string {
  return workflow.mediaType ?? 'image'
}

// Media-type groups, ordered so the list reads image -> video -> 3D.
type WorkflowGroup = { mediaType: string; label: string; workflows: ToolWorkflow[] }
const MEDIA_TYPE_ORDER = ['image', 'video', 'model3d']

// Sub-heading for a media group, phrased by the tool's input: "Generate" starts
// from text, "Transform image" starts from an image.
function mediaGroupLabel(toolName: string, mediaType: string): string {
  const input = toolName === 'comfyUI' ? 'Text' : 'Image'
  switch (mediaType) {
    case 'video':
      return `${input} to video`
    case 'model3d':
      return `${input} to 3D`
    default:
      return `${input} to image`
  }
}

// Presets for a tool grouped by output media type (image -> video -> 3D),
// dropping empty groups. Mirrors the per-media-type default slots.
function groupedPresetsForTool(toolName: string): WorkflowGroup[] {
  const workflows = presetsForTool(toolName)
  return MEDIA_TYPE_ORDER.map((mediaType) => ({
    mediaType,
    label: mediaGroupLabel(toolName, mediaType),
    workflows: workflows.filter((w) => normalizedMediaType(w) === mediaType),
  })).filter((group) => group.workflows.length > 0)
}

function mediaTypeLabel(mediaType?: string): string {
  switch (mediaType ?? 'image') {
    case 'video':
      return 'video'
    case 'model3d':
      return '3D model'
    default:
      return 'image'
  }
}

// Slot key matching the tools (getDefaultWorkflow) — "<toolName>:<mediaType>".
function slotKey(toolName: string, workflow: ToolWorkflow): string {
  return `${toolName}:${normalizedMediaType(workflow)}`
}

// Enabled workflow names in the same (tool, media type) slot — the candidate set
// the resolver picks from.
function enabledNamesInSlot(toolName: string, mediaType: string): string[] {
  return presetsForTool(toolName)
    .filter(
      (w) => normalizedMediaType(w) === mediaType && textInference.isWorkflowPresetEnabled(w.name),
    )
    .map((w) => w.name)
}

// A default choice only exists when the slot has more than one workflow. Based on
// total (not enabled) count so the control doesn't pop in/out as presets toggle.
function slotHasChoice(toolName: string, workflow: ToolWorkflow): boolean {
  const mediaType = normalizedMediaType(workflow)
  return presetsForTool(toolName).filter((w) => normalizedMediaType(w) === mediaType).length > 1
}

function isDefaultWorkflow(toolName: string, workflow: ToolWorkflow): boolean {
  return (
    textInference.getDefaultWorkflow(
      slotKey(toolName, workflow),
      enabledNamesInSlot(toolName, normalizedMediaType(workflow)),
    ) === workflow.name
  )
}

function chooseDefault(toolName: string, workflow: ToolWorkflow) {
  if (!isToolActive(toolName) || !textInference.isWorkflowPresetEnabled(workflow.name)) return
  textInference.setDefaultWorkflow(slotKey(toolName, workflow), workflow.name)
}

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
    label: 'Transform image',
    description:
      'Edit, upscale, colorize, or convert an existing image into a new image, video, or 3D model.',
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
      'Let the assistant search the web, open pages in a background browser to read their ' +
      'content, and (on vision models) capture a screenshot of a page.',
  },
  {
    name: 'synthesizeTextToSpeech',
    label: 'Text To Speech (Qwen3-TTS)',
    description:
      'Let the assistant turn text into spoken audio with a choice of voices and languages.',
  },
]

const modelSupportsVision = computed(() => textInference.modelSupportsVision)

const boundWindowName = computed(() => textInference.screenshotWindow?.name ?? 'None selected')

function toggle(toolName: string) {
  if (!textInference.aipgToolsEnabled) return
  textInference.setBuiltinToolEnabled(toolName, !textInference.isBuiltinToolEnabled(toolName))
}

function toggleWorkflow(toolName: string, workflowName: string) {
  if (!textInference.aipgToolsEnabled || !textInference.isBuiltinToolEnabled(toolName)) return
  textInference.setWorkflowPresetEnabled(
    workflowName,
    !textInference.isWorkflowPresetEnabled(workflowName),
  )
}
</script>

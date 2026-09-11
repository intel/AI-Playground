<template>
  <TooltipProvider>
    <SettingsPanel
      :title="isMediaVariant ? 'Media tools' : 'Built-in tools'"
      :switch-id="isMediaVariant ? 'media-tools' : 'tools'"
      :enabled="isMediaVariant ? undefined : textInference.aipgToolsEnabled"
      :disabled-reason="
        isMediaVariant || textInference.modelSupportsToolCalling
          ? undefined
          : languages.SETTINGS_TOOLS_MODEL_UNSUPPORTED
      "
      @update:enabled="textInference.aipgToolsEnabled = $event"
    >
      <div
        v-show="isMediaVariant || textInference.modelSupportsToolCalling"
        class="flex flex-col gap-3"
        :class="{ 'opacity-50': !toolsEnabled }"
      >
        <p v-if="isMediaVariant" class="text-xs text-muted-foreground">
          What the Media generation capability may reach for. Stored with this agent preset, so
          Chat's assistant keeps its own selection.
        </p>
        <!-- Media specialist delegation: one thin `media` tool instead of the two
             full comfy tool schemas in the model's context. -->
        <div class="flex items-center justify-between gap-3 pb-2 border-b border-border">
          <div class="flex items-center gap-1.5 min-w-0">
            <Label class="whitespace-nowrap">Media specialist agent</Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm">
                Route media generation through a nested specialist agent: the assistant sees a
                single lightweight "media" tool instead of the full workflow catalog, keeping its
                context small, and multi-step requests (e.g. image → 3D model) run in one call. In
                Agent Mode, changing this starts a new agent session on the next message.
              </TooltipContent>
            </Tooltip>
          </div>
          <Checkbox
            id="builtin-tool-delegation"
            :disabled="!toolsEnabled"
            :model-value="textInference.toolDelegationEnabled"
            @click="textInference.toolDelegationEnabled = !textInference.toolDelegationEnabled"
          />
        </div>
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
                :disabled="!toolsEnabled"
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
                    :disabled="!isToolActive(builtinTool.name)"
                    :model-value="textInference.isWorkflowPresetEnabled(workflow.name)"
                    @update:model-value="toggleWorkflow(builtinTool.name, workflow.name)"
                  />
                  <button
                    type="button"
                    :disabled="!isToolActive(builtinTool.name)"
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
                :disabled="!toolsEnabled"
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
      </div>

      <!-- Speech group: a single "Speech" entry (like "Generate media") that expands
           to the Text-to-Speech and Speech-to-Text sub-tools. -->
      <Collapsible :open="openTools['speech'] === true" class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1.5 min-w-0">
            <Label class="whitespace-nowrap">Speech</Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm">
                Let the assistant speak text aloud and transcribe audio.
              </TooltipContent>
            </Tooltip>
          </div>

          <div class="flex items-center gap-3">
            <CollapsibleTrigger
              :disabled="!textInference.aipgToolsEnabled"
              class="flex items-center gap-1.5 text-xs"
              :class="
                textInference.aipgToolsEnabled
                  ? 'text-muted-foreground cursor-pointer'
                  : 'text-muted-foreground opacity-50 cursor-not-allowed'
              "
              @click="openTools['speech'] = !openTools['speech']"
            >
              <span class="whitespace-nowrap">{{ enabledSpeechCount }}/2 enabled</span>
              <ChevronDownIcon
                class="size-4 transition-transform"
                :class="{ 'rotate-180': openTools['speech'] }"
              />
            </CollapsibleTrigger>
            <Checkbox
              id="builtin-tool-speech"
              :disabled="!textInference.aipgToolsEnabled"
              :model-value="isSpeechEnabled"
              @click="toggleSpeech"
            />
          </div>
        </div>

        <CollapsibleContent class="flex flex-col gap-1.5 pl-4 pt-1">
          <div
            v-for="child in speechChildren"
            :key="child.name"
            class="flex items-center justify-between gap-3"
          >
            <div class="flex items-center gap-2 min-w-0">
              <Switch
                :id="`builtin-tool-${child.name}`"
                :disabled="!textInference.aipgToolsEnabled"
                :model-value="textInference.isBuiltinToolEnabled(child.name)"
                @update:model-value="toggleSpeechChild(child.name)"
              />
              <button
                type="button"
                :disabled="!textInference.aipgToolsEnabled"
                class="text-xs text-foreground truncate text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                @click="toggleSpeechChild(child.name)"
              >
                {{ child.label }}
              </button>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-3.5 h-3.5 shrink-0 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" class="max-w-[300px] text-sm">
                  {{ child.description }}
                </TooltipContent>
              </Tooltip>
            </div>

            <!-- "Speak replies" rides on the Text To Speech row: that tool supplies
                 the voice, so the toggle follows it being enabled. Stored per chat
                 preset, so it applies to the active one — the assistant auto-plays
                 its reply in the app, the Home Agent answers a voice message with a
                 voice message. -->
            <div
              v-if="child.name === 'synthesizeTextToSpeech'"
              class="flex items-center gap-2 shrink-0"
            >
              <Tooltip>
                <TooltipTrigger as-child>
                  <label
                    class="flex items-center gap-2"
                    :class="speakRepliesEditable ? 'cursor-pointer' : 'opacity-50'"
                  >
                    <span class="text-xs text-foreground whitespace-nowrap">Speak replies</span>
                    <Switch
                      id="speak-replies"
                      :disabled="!speakRepliesEditable"
                      :model-value="textInference.speakReplies"
                      @update:model-value="textInference.speakReplies = $event"
                    />
                  </label>
                </TooltipTrigger>
                <TooltipContent side="left" class="max-w-[300px] text-sm">
                  Answer aloud when your input was speech: the app auto-plays the reply to a
                  microphone message, and the Home Agent replies to a voice message with a voice
                  message. Applies to the active preset.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ScreenshotWindowDialog v-model:open="showWindowDialog" />
    </SettingsPanel>
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
import SettingsPanel from '@/components/SettingsPanel.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ScreenshotWindowDialog from '@/components/ScreenshotWindowDialog.vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { usePresets, type Preset } from '@/assets/js/store/presets'

// `media` is the Agent Mode slice: the media tools and their workflows, without
// Chat's master switch (an agent's tools hang off its Media generation
// capability) and without the tools an agent gets as capabilities instead.
const props = withDefaults(defineProps<{ variant?: 'chat' | 'media' }>(), { variant: 'chat' })

const textInference = useTextInference()
const presets = usePresets()
const showWindowDialog = ref(false)

const isMediaVariant = computed(() => props.variant === 'media')

// Whether the panel's contents are live at all. Agent Mode ignores the chat
// master switch (see getAgentToolSpecs), so the media slice is always live.
const toolsEnabled = computed(() => isMediaVariant.value || textInference.aipgToolsEnabled)

// Per-tool expand/collapse state for the preset lists. Collapsed by default.
const openTools = ref<Record<string, boolean>>({})

// A tool is "active" (interactive, expandable) only when both the master tools
// toggle and the tool's own checkbox are on. Inactive tools stay collapsed with
// a greyed-out summary.
function isToolActive(toolName: string): boolean {
  return toolsEnabled.value && textInference.isBuiltinToolEnabled(toolName)
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

// The media tools, in the order they appear. Everything else an agent can do is
// a capability of its own, so the media slice lists only these two.
const MEDIA_TOOLS = ['comfyUI', 'comfyUiImageEdit']

// User-facing descriptors for the built-in (internal) tools. Keys must match the
// tool names registered in `aipgTools`.
const allBuiltinTools: Array<{ name: string; label: string; description: string }> = [
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
]

// Speech is presented as a single "Speech" group (like "Generate media") whose
// children are the two independent speech tools. The group's master checkbox
// enables/disables both; the sub-toggles control each tool individually.
const speechChildren: Array<{ name: string; label: string; description: string }> = [
  {
    name: 'synthesizeTextToSpeech',
    label: 'Text To Speech',
    description:
      'Let the assistant turn text into spoken audio with a choice of voices and languages.',
  },
  {
    name: 'transcribeAudio',
    label: 'Speech To Text',
    description:
      'Let the assistant transcribe an attached voice message or audio file into text with Whisper.',
  },
]

const builtinTools = computed(() =>
  isMediaVariant.value
    ? allBuiltinTools.filter((tool) => MEDIA_TOOLS.includes(tool.name))
    : allBuiltinTools,
)

// The "Speak replies" toggle rides on the Text To Speech tool: with that tool off
// (or tools off entirely) nothing can synthesize a reply, so it is inert.
const speakRepliesEditable = computed(() => isToolActive('synthesizeTextToSpeech'))

const enabledSpeechCount = computed(
  () => speechChildren.filter((c) => textInference.isBuiltinToolEnabled(c.name)).length,
)
const isSpeechEnabled = computed(() => enabledSpeechCount.value > 0)

// Master toggle: turn the whole Speech group on/off (both children follow).
function toggleSpeech() {
  if (!textInference.aipgToolsEnabled) return
  const target = !isSpeechEnabled.value
  for (const child of speechChildren) {
    textInference.setBuiltinToolEnabled(child.name, target)
  }
}

function toggleSpeechChild(toolName: string) {
  if (!textInference.aipgToolsEnabled) return
  textInference.setBuiltinToolEnabled(toolName, !textInference.isBuiltinToolEnabled(toolName))
}

const modelSupportsVision = computed(() => textInference.modelSupportsVision)

const boundWindowName = computed(() => textInference.screenshotWindow?.name ?? 'None selected')

function toggle(toolName: string) {
  if (!toolsEnabled.value) return
  textInference.setBuiltinToolEnabled(toolName, !textInference.isBuiltinToolEnabled(toolName))
}

function toggleWorkflow(toolName: string, workflowName: string) {
  if (!isToolActive(toolName)) return
  textInference.setWorkflowPresetEnabled(
    workflowName,
    !textInference.isWorkflowPresetEnabled(workflowName),
  )
}
</script>

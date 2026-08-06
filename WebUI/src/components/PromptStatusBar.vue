<template>
  <!-- min-h keeps the row the same height in every mode: the context widget and
       zoom controls (28px) are chat-only, so without it the row would collapse to
       the preset chip's height and sit closer to the prompt input. -->
  <div class="flex w-full items-center gap-2 m-1 min-h-7 text-xs text-muted-foreground">
    <!-- Active preset / model indicator -->
    <div
      v-if="presetIndicator"
      role="status"
      :aria-label="`Active preset: ${presetIndicator.name}`"
      class="flex min-w-0 items-center gap-2"
    >
      <TooltipProvider>
        <Tooltip :delay-duration="0">
          <TooltipTrigger as-child>
            <button type="button" class="flex min-w-0 items-center gap-1 text-left cursor-help">
              <img
                v-if="presetIndicator.image"
                :src="presetIndicator.image"
                :alt="presetIndicator.name"
                class="size-5 rounded object-cover flex-none border border-border"
              />
              <span class="text-foreground font-medium truncate">{{ presetIndicator.name }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ presetIndicator.name }}</p>
            <p v-if="presetIndicator.description" class="mt-1 text-xs text-muted-foreground">
              {{ presetIndicator.description }}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div v-if="presetIndicator.model && currentModel">·</div>
      <ModelCapabilities
        v-if="presetIndicator.model && currentModel"
        :model="currentModel"
        show-name
        :delay-duration="0"
      >
        <template #trigger>
          <button type="button" class="truncate text-left cursor-help">
            {{ presetIndicator.model }}
          </button>
        </template>
      </ModelCapabilities>
      <span v-else-if="presetIndicator.model" class="truncate">{{ presetIndicator.model }}</span>
      <!-- Capability icons for the active model, only in the Assistant preset -->
      <CapabilityIcons
        v-if="isAssistantPreset && presetIndicator.model && currentModel"
        :model="currentModel"
        icon-size="size-3.5"
        :delay-duration="0"
      />
      <!-- Active chat inference backend (llama.cpp / OpenVINO) -->
      <template v-if="chatBackendBadge">
        ·
        <TooltipProvider>
          <Tooltip :delay-duration="0">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex flex-none items-center cursor-help"
                :aria-label="`Inference backend: ${chatBackendBadge.name}`"
              >
                <img
                  :src="chatBackendBadge.logo"
                  :alt="chatBackendBadge.name"
                  class="size-4 flex-none object-contain"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent
              align="start"
              class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
            >
              <p class="text-sm font-semibold">{{ chatBackendBadge.name }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ chatBackendBadge.description }}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </template>
      <!-- Selected inference device (GPU / NPU / CPU) as a text badge -->
      <template v-if="deviceBadge">
        <TooltipProvider>
          <Tooltip :delay-duration="0">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex flex-none items-center cursor-help"
                :aria-label="`Inference device: ${deviceBadge.name}`"
              >
                <span
                  class="flex-none rounded border border-border px-1 text-[10px] font-semibold leading-4 tracking-tight text-muted-foreground"
                >
                  {{ deviceBadge.categoryLabel }}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              align="start"
              class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
            >
              <p class="text-sm font-semibold">{{ deviceBadge.name }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ deviceBadge.categoryLabel }}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </template>
    </div>
    <!-- Context usage (chat only). Sibling of the status element so the live
         region doesn't re-announce the token percentage on every stream tick. -->
    <div v-if="isChatMode">·</div>
    <Context
      v-if="isChatMode"
      trigger-size="xs"
      :used-tokens="contextUsedTokens"
      :max-tokens="contextMaxTokens"
      :max-context-size="textInference.maxContextSizeFromModel"
      :dynamic-context="textInference.contextSizeIsDynamic"
      :usage="contextUsage"
    />
    <!-- Font zoom controls (chat only) -->
    <div v-if="isChatMode" class="ml-auto flex flex-none gap-1">
      <button
        @click="textInference.decreaseFontSize()"
        :disabled="textInference.isMinSize"
        class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Decrease font size"
      >
        <MagnifyingGlassMinusIcon class="size-5" />
      </button>
      <button
        @click="textInference.increaseFontSize()"
        :disabled="textInference.isMaxSize"
        class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Increase font size"
      >
        <MagnifyingGlassPlusIcon class="size-5" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon } from '@heroicons/vue/24/outline'
import llamaCppLogoDark from '@/assets/image/llamacpp-dark.svg'
import llamaCppLogoLight from '@/assets/image/llamacpp-light.svg'
import openVinoLogoDark from '@/assets/image/openvino-dark.svg'
import openVinoLogoLight from '@/assets/image/openvino-light.svg'
import { usePromptStore } from '@/assets/js/store/promptArea'
import {
  useTextInference,
  textInferenceBackendDisplayName,
  backendToService,
} from '@/assets/js/store/textInference'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets.ts'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useTheme } from '@/assets/js/store/theme'
import { Context } from '@/components/ui/context'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ModelCapabilities from '@/components/ModelCapabilities.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'

const promptStore = usePromptStore()
const textInference = useTextInference()
const backendServices = useBackendServices()
const openAiCompatibleChat = useOpenAiCompatibleChat()
const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const theme = useTheme()

// The backend badge logos ship as light/dark variants; only the `light` theme
// needs the dark-fill icon, all other themes are dark-background.
const isLightTheme = computed(() => theme.active === 'light')

const isChatMode = computed(() => promptStore.getCurrentMode() === 'chat')

// Get active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Remember the most recent chat preset so the indicator stays stable while a
// tool call or Home Agent turn temporarily switches the active preset to a
// ComfyUI one during agentic tool use.
const stableChatPreset = ref<ChatPreset | null>(null)
watch(
  activeChatPreset,
  (preset) => {
    if (preset) stableChatPreset.value = preset
  },
  { immediate: true },
)

// On startup no preset switch has run yet (presets/backends load async), so
// `activePresetWithVariant` — and thus `stableChatPreset` — can be null even
// though there is a persisted last-used preset. Fall back to it (or the first
// available chat preset) so the indicator isn't blank at launch.
const fallbackChatPreset = computed<ChatPreset | null>(() => {
  const chatPresets = presetsStore.chatPresets
  if (chatPresets.length === 0) return null
  const lastUsed = presetsStore.getLastUsedPreset(['chat'])
  return chatPresets.find((p) => p.name === lastUsed) ?? chatPresets[0]
})

// The direct Text-to-Speech preset runs the Qwen3-TTS backend, not an LLM. It's
// still "chat" mode, so without this the bar would show the leftover chat model
// (e.g. llama) and the chat backend's device. Treat it specially throughout.
const isTtsPreset = computed(
  () => (stableChatPreset.value ?? fallbackChatPreset.value)?.ttsPreset === true,
)

// Preset/model indicator shown at the left of the bar. Keyed off the user's
// selected mode (not `currentMode`) so background comfy switches during
// agentic / Home Agent tool use don't flip it.
const presetIndicator = computed(() => {
  if (promptStore.userSelectedMode === 'chat') {
    const preset = stableChatPreset.value ?? fallbackChatPreset.value
    if (!preset) return null
    // Match the ModelSelector label: display only the last path segment, and
    // drop the model-file extension (the backend badge now conveys the format).
    // TTS has no LLM model, so leave it blank.
    const model = isTtsPreset.value ? undefined : textInference.activeModel
    const lastSegment = model?.split('/').at(-1) ?? model
    return {
      image: preset.image,
      name: preset.name,
      model: lastSegment?.replace(/\.(gguf|bin|safetensors)$/i, ''),
      description: basePresetDescription(preset.name),
    }
  }
  const preset = imageGeneration.activePreset
  if (!preset) return null
  return {
    image: preset.image,
    name: preset.name,
    model: undefined as string | undefined,
    description: basePresetDescription(preset.name),
  }
})

// Small badge on the preset/model line showing which local inference backend is
// active for chat. Keyed off `userSelectedMode` (like presetIndicator) so a
// background comfy switch during agentic tool use doesn't flip it. Hidden for
// non-chat modes and for Cloud Mode (no local llama.cpp / OpenVINO engine).
const chatBackendBadge = computed(() => {
  if (promptStore.userSelectedMode !== 'chat') return null
  // TTS doesn't run on llama.cpp / OpenVINO, so no engine badge for it.
  if (isTtsPreset.value) return null
  const backend = textInference.backend
  if (backend !== 'llamaCPP' && backend !== 'openVINO') return null
  return {
    name: textInferenceBackendDisplayName[backend],
    description:
      backend === 'llamaCPP'
        ? 'Chat is running on the llama.cpp backend (GGUF models).'
        : 'Chat is running on the OpenVINO backend (OpenVINO IR models).',
    logo:
      backend === 'llamaCPP'
        ? isLightTheme.value
          ? llamaCppLogoLight
          : llamaCppLogoDark
        : isLightTheme.value
          ? openVinoLogoLight
          : openVinoLogoDark,
  }
})

// Classify any InferenceDevice into a short GPU / NPU / CPU badge. OpenVINO uses ids
// like 'NPU' / 'CPU' / 'GPU.0'; llama.cpp reports numeric ids with GPU names; ComfyUI
// reports numeric GPU indices; TTS uses torch strings ('xpu:N' / 'cuda:N' / 'cpu').
// Anything not NPU/CPU is treated as GPU (covers 'GPU.x', 'AUTO', 'xpu:N', 'cuda:N' and
// named GPU devices). We deliberately don't split integrated vs discrete: `InferenceDevice`
// carries no reliable flag for it (that only lives on `GpuHardwareDevice.category`).
function classifyInferenceDevice(device: InferenceDevice) {
  const haystack = `${device.id} ${device.name}`.toUpperCase()
  const category: 'gpu' | 'npu' | 'cpu' = haystack.includes('NPU')
    ? 'npu'
    : device.id.toUpperCase() === 'CPU' || /\bCPU\b/.test(haystack)
      ? 'cpu'
      : 'gpu'
  const categoryLabel = category === 'npu' ? 'NPU' : category === 'cpu' ? 'CPU' : 'GPU'
  return { name: device.name || device.id, category, categoryLabel }
}

// The selected-device badge for a backend service, or null when it isn't running /
// hasn't reported a device selection yet.
function selectedDeviceBadgeFor(serviceName: BackendServiceName) {
  const info = backendServices.info.find((s) => s.serviceName === serviceName)
  const device = info?.devices.find((d) => d.selected)
  return device ? classifyInferenceDevice(device) : null
}

// Selected inference device shown as a short text badge (GPU / NPU / CPU), device name
// on hover — for whichever backend the active mode actually runs on, not just the chat
// engine: llama.cpp / OpenVINO (or TTS) in chat mode, and ComfyUI in the Image / Image
// Edit / Video modes. Null on Cloud Mode (remote — no local hardware) and before device
// detection has reported a selection.
const deviceBadge = computed(() => {
  if (promptStore.userSelectedMode === 'chat') {
    if (isTtsPreset.value) return selectedDeviceBadgeFor('qwen3-tts-backend')
    const backend = textInference.backend
    if (backend === 'cloud') return null
    const serviceName = backendToService[backend]
    return serviceName ? selectedDeviceBadgeFor(serviceName) : null
  }
  // Image / Image Edit / Video modes all run on the ComfyUI backend.
  return selectedDeviceBadgeFor('comfyui-backend')
})

// The tooltip shows the base preset's description — same text as the quick
// preset picker. `stableChatPreset` / `imageGeneration.activePreset` are
// variant-merged, where `description` can be a per-variant blurb instead.
function basePresetDescription(name: string): string | undefined {
  return presetsStore.presets.find((p) => p.name === name)?.description
}

// Active model object (capabilities, max context) — same source as ModelSelector.
// Undefined for models without metadata (e.g. cloud models), which hides the tooltip.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

// The merged Assistant preset shows per-capability icons in the banner; other
// presets keep just the ModelCapabilities info tooltip.
const isAssistantPreset = computed(() => presetIndicator.value?.name === 'Assistant')

// Context usage data for Context component
const contextUsedTokens = computed(() => openAiCompatibleChat.usedTokens)
const contextMaxTokens = computed(() =>
  textInference.contextSizeIsDynamic
    ? (textInference.maxContextSizeFromModel ?? 0)
    : textInference.contextSize,
)
const contextUsage = computed(() => openAiCompatibleChat.contextUsage)
</script>

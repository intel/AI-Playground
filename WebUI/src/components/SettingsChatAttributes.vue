<template>
  <TooltipProvider :delay-duration="200">
    <SettingsTabLayout :machine-only="isHomeAgentPresetActive" :machine-note="machineNote">
      <SettingsRow v-if="advancedMode" align="start">
        <template #label>
          <Label for="chat-system-prompt" class="whitespace-nowrap pt-2">{{
            languages.SETTINGS_SYSTEM_PROMPT
          }}</Label>
        </template>
        <Textarea
          id="chat-system-prompt"
          v-model="textInference.systemPrompt"
          :placeholder="languages.SETTINGS_SYSTEM_PROMPT_PLACEHOLDER"
          class="min-h-[100px] text-sm"
        />
      </SettingsRow>

      <SettingsRow v-if="showRetrievalModeToggle" :label="languages.RAG_RETRIEVAL_MODE">
        <div class="flex flex-col gap-1">
          <div class="inline-flex w-fit overflow-hidden rounded-md border border-border">
            <button
              type="button"
              class="h-[30px] px-3 text-sm transition-colors"
              :class="
                effectiveRagMode === 'standard'
                  ? 'bg-primary text-foreground'
                  : 'bg-transparent hover:bg-primary/20'
              "
              @click="textInference.ragMode = 'standard'"
            >
              {{ languages.RAG_MODE_STANDARD }}
            </button>
            <button
              type="button"
              :disabled="disableRetrievalModeToggle"
              class="h-[30px] border-l border-border px-3 text-sm transition-colors"
              :class="[
                effectiveRagMode === 'phisonKm'
                  ? 'bg-primary text-foreground'
                  : 'bg-transparent hover:bg-primary/20',
                disableRetrievalModeToggle ? 'cursor-not-allowed opacity-50' : '',
              ]"
              @click="textInference.ragMode = 'phisonKm'"
            >
              {{ languages.RAG_MODE_PHISON_KM }}
            </button>
          </div>
          <p v-if="retrievalModeUnavailableReason" class="text-xs text-muted-foreground">
            {{ retrievalModeUnavailableReason }}
          </p>
        </div>
      </SettingsRow>
      <!-- The uploader opens from the embedding row: documents are indexed with that model. -->
      <SettingsRow v-if="enableRAG" :label="languages.AGENT_SETTINGS_EMBEDDINGS">
        <!-- A grid: as a grid item the dropdown stretches, which a flex child of DropDownNew does not. -->
        <div class="grid grid-cols-[1fr_auto] items-center gap-2 min-w-0">
          <drop-down-new
            :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
            @change="(item) => textInference.selectEmbeddingModel(textInference.backend, item)"
            :value="activeEmbeddingModelName"
            :items="embeddingModelItems"
          ></drop-down-new>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="secondary"
                class="h-[30px] shrink-0 gap-1.5 rounded px-2 text-sm"
                @click="showUploader = !showUploader"
                :aria-label="documentButtonText"
              >
                <DocumentTextIcon class="size-4" />
                <span v-if="documentStats.total > 0" class="text-xs">
                  {{ documentStats.enabled }}
                </span>
                <PlusIcon v-else class="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ documentButtonText }}</TooltipContent>
          </Tooltip>
        </div>
      </SettingsRow>

      <template v-if="showTools">
        <SettingsBuiltinTools />
        <SettingsMcp />
      </template>

      <template #reset-fallback>
        <PresetResetButton :reset="textInference.resetActivePresetSettings" />
      </template>

      <template v-if="showUploader" #after>
        <rag @close="showUploader = false"></rag>
      </template>
    </SettingsTabLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { DocumentTextIcon, PlusIcon } from '@heroicons/vue/24/solid'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTextInference } from '@/assets/js/store/textInference.ts'
import { useI18N } from '@/assets/js/store/i18n.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import PresetResetButton from '@/components/PresetResetButton.vue'
import Rag from '@/components/Rag.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import SettingsMcp from '@/components/SettingsMcp.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import { useActiveChatPreset } from '@/assets/js/activeChatPreset'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'

const showUploader = ref(false)
const languages = useI18N().state
const textInference = useTextInference()

const { activeChatPreset, isHomeAgentPresetActive, machineNote } = useActiveChatPreset()

const { activeName: activeEmbeddingModelName, items: embeddingModelItems } =
  useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => textInference.backend,
  )

const enableRAG = computed(() => activeChatPreset.value?.enableRAG ?? false)
const showTools = computed(() => activeChatPreset.value?.showTools ?? false)
const advancedMode = computed(() => activeChatPreset.value?.advancedMode ?? false)
const showRetrievalModeToggle = computed(
  () =>
    enableRAG.value &&
    activeChatPreset.value?.supportsPhisonKmRag === true &&
    textInference.phisonSsdPresent,
)
const disableRetrievalModeToggle = computed(() => !textInference.phisonKmAvailable)
const effectiveRagMode = computed(() => (textInference.isPhisonKmRag ? 'phisonKm' : 'standard'))
const retrievalModeUnavailableReason = computed(() => {
  if (textInference.phisonKmAvailable) return ''
  return textInference.kmContextFloorReachable
    ? languages.PHISON_KM_UNAVAILABLE_BUILD_HINT
    : languages.PHISON_KM_UNAVAILABLE_CONTEXT_HINT
})

const documentStats = computed(() => {
  const totalDocs = textInference.ragList.length
  const enabledDocs = textInference.ragList.filter((doc) => doc.isChecked).length
  return { total: totalDocs, enabled: enabledDocs }
})

const documentButtonText = computed(() =>
  documentStats.value.total === 0
    ? languages.RAG_ADD_DOCUMENTS
    : `${languages.RAG_DOCUMENTS} (${documentStats.value.enabled})`,
)
</script>

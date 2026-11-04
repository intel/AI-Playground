<template>
  <SettingsSection
    :title="i18n.AGENT_SECTION_INFERENCING"
    :summary="binding.currentModel?.name"
    :attention="hasProblem('backend', 'cloudProvider', 'model')"
  >
    <!-- A fieldset, so every control below (Reka triggers are buttons too) is disabled natively. -->
    <fieldset
      :disabled="disabled"
      class="flex flex-col gap-6 min-w-0"
      :aria-describedby="describedBy"
    >
      <div class="grid grid-cols-[120px_1fr] items-center gap-4" :class="problemClass('backend')">
        <Label class="whitespace-nowrap">{{ i18n.AGENT_SETTING_BACKEND }}</Label>
        <drop-down-new
          :title="i18n.AGENT_SETTINGS_SELECT_BACKEND"
          :value="binding.backend"
          :items="binding.backendItems"
          @change="binding.setBackend"
        ></drop-down-new>
      </div>
      <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
      <div
        v-if="binding.backend === 'cloud'"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('cloudProvider')"
      >
        <Label class="whitespace-nowrap">{{ i18n.AGENT_SETTING_PROVIDER }}</Label>
        <slot name="provider" />
      </div>
      <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ i18n.DEVICE }}</Label>
        <slot name="device" />
      </div>
      <!-- The picker's trigger is named after the selected model, so the row carries the
           stable name saying what the control is for. -->
      <div
        role="group"
        :aria-label="i18n.MODEL"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('model')"
      >
        <Label class="whitespace-nowrap">{{ i18n.MODEL }}</Label>
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex-1 min-w-0">
            <slot name="model" />
          </div>
          <CapabilityIcons v-if="binding.currentModel" :model="binding.currentModel" />
        </div>
      </div>
      <div
        v-if="binding.contextSizeSupported"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label :for="contextSizeId" class="whitespace-nowrap">
          {{ i18n.ANSWER_CONTEXT_SIZE }}
        </Label>
        <div class="flex items-center gap-3">
          <input
            :id="contextSizeId"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :value="contextSizeField.draft"
            class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border disabled:opacity-50"
            @focus="contextSizeField.onFocus"
            @input="contextSizeField.onInput"
            @blur="contextSizeField.commit"
            @keydown.enter="contextSizeField.commit"
          />
          <span v-if="binding.contextSize < 16384" class="text-xs text-amber-500">
            {{ i18n.AGENT_SETTINGS_CONTEXT_HINT }}
          </span>
        </div>
      </div>
      <p v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
        {{ i18n.AGENT_SETTINGS_SHARED_WITH_CHAT }}
      </p>

      <!-- Only models whose template honours enable_thinking can be told to stop, and only a
           session that thinks has anything to shorten. -->
      <div v-if="binding.thinkingToggleSupported" class="flex flex-col gap-2">
        <Label class="whitespace-nowrap">{{ i18n.AGENT_SETTINGS_THINKING }}</Label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="binding.thinkingEnabled"
            @change="binding.setThinkingEnabled(!binding.thinkingEnabled)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ i18n.AGENT_SETTINGS_THINK_BEFORE_ACTING }}</span>
            <span v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
              {{ i18n.AGENT_SETTINGS_THINKING_SHARED }}
            </span>
          </span>
        </label>
        <label v-if="binding.planningPhaseSupported" class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!binding.thinkingEnabled"
            :checked="binding.planningThinkingOnly"
            @change="binding.setPlanningThinkingOnly(!binding.planningThinkingOnly)"
          />
          <span class="flex flex-col">
            <span class="text-foreground" :class="{ 'opacity-50': !binding.thinkingEnabled }">
              {{ i18n.AGENT_SETTINGS_PLANNING_ONLY }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ i18n.AGENT_SETTINGS_PLANNING_ONLY_HINT }}
            </span>
          </span>
        </label>
      </div>
    </fieldset>
  </SettingsSection>

  <SettingsSection
    :title="i18n.AGENT_SETTINGS_CAPABILITIES"
    :summary="enabledCapabilityLabels"
    :attention="hasProblem('embeddingModel')"
  >
    <fieldset
      :disabled="disabled"
      class="flex flex-col gap-3 min-w-0"
      :aria-describedby="describedBy"
    >
      <p class="text-xs text-muted-foreground">
        {{ i18n.AGENT_SETTINGS_CAPABILITIES_HINT }}
      </p>
      <AgentCapabilityChecklist
        :model-value="binding.capabilities"
        :catalog="binding.capabilityCatalog"
        @update:model-value="binding.setCapabilities"
      >
        <template #after="{ id }">
          <!-- Same selector as Chat Settings' Embeddings row, but bound to the embedding
               backend rather than the chat backend: an agent can run on a cloud model while
               its document search stays local. The model downloads on first rag use. -->
          <div
            v-if="id === 'rag' && ragEnabled"
            class="grid grid-cols-[120px_1fr] items-center gap-4"
            :class="problemClass('embeddingModel')"
          >
            <Label class="whitespace-nowrap">{{ i18n.AGENT_SETTINGS_EMBEDDINGS }}</Label>
            <drop-down-new
              :title="i18n.RAG_DOCUMENT_EMBEDDING_MODEL"
              :value="binding.embeddingModelName"
              :items="binding.embeddingModelItems"
              @change="binding.setEmbeddingModel"
            ></drop-down-new>
          </div>
        </template>
      </AgentCapabilityChecklist>
      <slot name="capability-extras" />
    </fieldset>
  </SettingsSection>

  <!-- Shown whenever the capability exists, including while it reports itself unavailable:
       turning every workflow off is what makes it unavailable, and this is where they are
       turned back on. -->
  <SettingsSection v-if="hasMediaCapability" :title="i18n.AGENT_SECTION_MEDIA_TOOLS">
    <fieldset :disabled="disabled" class="flex flex-col min-w-0" :aria-describedby="describedBy">
      <SettingsBuiltinTools variant="media" bare :settings="binding.mediaTools" />
    </fieldset>
  </SettingsSection>

  <SettingsSection
    :title="i18n.AGENT_SECTION_MCP_SERVERS"
    :summary="enabledMcpServerNames"
    :attention="missingMcpServers.length > 0"
  >
    <fieldset
      :disabled="disabled"
      class="flex flex-col gap-2 min-w-0"
      :aria-describedby="describedBy"
    >
      <p
        v-for="serverId in missingMcpServers"
        :key="serverId"
        class="text-xs text-amber-500 rounded-sm ring-1 ring-amber-500 px-2 py-1"
      >
        {{ describeMissingMcpServer(serverId) }}
      </p>
      <AgentMcpServerChecklist
        :model-value="binding.capabilities"
        :servers="mcp.allServers"
        @update:model-value="binding.setCapabilities"
      />
    </fieldset>
  </SettingsSection>

  <p v-if="liveSession" class="text-xs text-amber-500">
    {{ i18n.AGENT_SETTINGS_NEXT_TURN }}
  </p>

  <slot name="footer" />
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import AgentCapabilityChecklist from '@/components/AgentCapabilityChecklist.vue'
import AgentMcpServerChecklist from '@/components/AgentMcpServerChecklist.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import SettingsSection from '@/components/SettingsSection.vue'
import { Label } from '@/components/ui/label'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import { MCP_CAPABILITY_PREFIX, mcpCapabilityId } from '@/types/agentCapabilities'

const props = defineProps<{
  binding: AgentSettingsBinding
  idPrefix: string
  disabled?: boolean
  describedBy?: string
  /** Bound to an open session, whose changes reach the agent on its next turn. */
  liveSession?: boolean
}>()

const mcp = useMcp()
const i18n = useI18N().state

const contextSizeId = computed(() => `${props.idPrefix}-context-size`)
const contextSize = computed<number>({
  get: () => props.binding.contextSize,
  set: (value) => props.binding.setContextSize(value),
})
const contextSizeField = useContextSizeField(contextSize)

const hasMediaCapability = computed(() =>
  props.binding.capabilityCatalog.some((capability) => capability.id === 'media'),
)

// The embedding picker belongs to the rag capability; hide it with the checkbox.
const ragEnabled = computed(
  () =>
    props.binding.capabilityCatalog.some((capability) => capability.id === 'rag') &&
    props.binding.capabilities.includes('rag'),
)

const enabledCapabilityLabels = computed(() =>
  props.binding.capabilityCatalog
    .filter(
      (capability) =>
        !capability.id.startsWith(MCP_CAPABILITY_PREFIX) &&
        props.binding.capabilities.includes(capability.id),
    )
    .map((capability) => capability.label)
    .join(', '),
)

const enabledMcpServerNames = computed(() =>
  mcp.allServers
    .filter((server) => props.binding.capabilities.includes(mcpCapabilityId(server.id)))
    .map((server) => server.name)
    .join(', '),
)

const { problemClass, hasProblem, missingMcpServers, describeMissingMcpServer } =
  useSettingsProblemMarks(() => props.binding.problems)

onMounted(() => {
  void mcp.refreshAvailableServers()
})
</script>

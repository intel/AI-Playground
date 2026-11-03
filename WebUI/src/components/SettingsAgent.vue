<template>
  <div class="flex flex-col gap-4 p-1">
    <!-- Same picker as Chat Settings: agent presets are chat presets, so this is how
         the user gets back to a plain chat preset (and vice versa). -->
    <PresetSelector
      type="chat"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
    />

    <AgentSaveBar v-if="agentMode.sessionScoped" />

    <!-- Managed workspace: the app owns one folder per game, so there is nothing
         to pick — only the game to start over with. -->
    <div v-if="isManagedWorkspace" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Game folder</Label>
      <div class="flex items-center gap-3">
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          @click="agentMode.newGame()"
        >
          New game
        </Button>
        <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ agentMode.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">
          Created when you describe your first game
        </span>
      </div>
      <p class="text-xs text-muted-foreground">
        Each game gets its own folder in your game library, and each folder its own session (Show
        Sessions).
      </p>
    </div>

    <!-- Workspace folder -->
    <div v-else class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Workspace folder</Label>
      <div class="flex items-center gap-3">
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="pickFolder">
          Select folder…
        </Button>
        <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ agentMode.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">No folder selected</span>
      </div>
      <p class="text-xs text-amber-500">
        The agent reads and writes files freely inside this folder — use a scratch folder.
      </p>
    </div>

    <SettingsSection
      v-if="agentMode.sessionScoped"
      :title="i18n.AGENT_TASK_STEPS"
      :summary="stepsSummary"
    >
      <TaskStepsEditor
        :steps="agentMode.openSteps"
        id-prefix="agent-steps"
        @update:steps="agentMode.setOpenSteps"
      />
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_STEPS_HINT }}</p>
    </SettingsSection>

    <!-- Shell sandbox (per-workspace opt-in, developer mode only) -->
    <SettingsSection v-if="showShellOption" :title="i18n.AGENT_SECTION_SHELL">
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!agentMode.workspaceDir"
          :checked="agentMode.unsandboxed"
          @change="toggleUnsandboxed"
        />
        <span class="flex flex-col">
          <span class="text-foreground">Use the real system shell in this folder</span>
          <span class="text-xs text-muted-foreground">
            Off by default: the agent gets an emulated shell with no network and no package
            managers, and its file access cannot leave the workspace folder. Turning this on gives
            it a real shell with node, npm, python and live network access, so it can install
            dependencies and run builds.
          </span>
        </span>
      </label>
      <p v-if="agentMode.unsandboxed" class="text-xs text-amber-500">
        Commands run on your machine with your user's permissions and can reach the network. File
        writes are still limited to the workspace, but a command can do anything you could do in a
        terminal. This applies only to {{ agentMode.workspaceDir }} — selecting another folder
        returns to the sandboxed shell.
      </p>
      <p v-else-if="!agentMode.workspaceDir" class="text-xs text-muted-foreground italic">
        Select a workspace folder first.
      </p>
    </SettingsSection>

    <p
      v-if="settingsReadOnly"
      id="agent-settings-read-only"
      class="text-xs text-muted-foreground rounded-sm ring-1 ring-border px-2 py-1"
    >
      {{ i18n.AGENT_TASK_SESSION_SETTINGS_READ_ONLY }}
    </p>

    <AgentSettingsForm
      :binding="binding"
      id-prefix="agent"
      :disabled="settingsReadOnly"
      :described-by="settingsReadOnly ? 'agent-settings-read-only' : undefined"
      live-session
    >
      <template #provider><ProviderSelector /></template>
      <template #device><DeviceSelector :backend="deviceServiceName" /></template>
      <!-- Same picker as Chat Settings, so an agent preset's requirements (tool calling, and
           coding for Game Agent) filter the list here too. -->
      <template #model><ModelSelector auto-select /></template>

      <!-- Slash commands of the enabled capabilities: sending one as a prompt is exactly how
           the agent's own input dispatches it. -->
      <template #capability-extras>
        <div v-if="capabilityCommands.length > 0" class="flex flex-col gap-2">
          <Label class="whitespace-nowrap mt-2">{{
            i18n.AGENT_SETTINGS_CAPABILITY_COMMANDS
          }}</Label>
          <div class="flex flex-wrap gap-2">
            <Button
              v-for="command in capabilityCommands"
              :key="command.command"
              variant="secondary"
              class="px-3 py-1.5 rounded text-sm"
              :disabled="agentMode.processing"
              :title="command.description"
              @click="agentMode.generate(command.command)"
            >
              {{ command.command }}
            </Button>
          </div>
        </div>
      </template>

      <!-- Same reset affordance the Chat, Audio and workflow panels carry, so every preset
           offers a way back to its defaults. -->
      <template #footer>
        <div
          v-if="agentMode.sessionScoped && !agentTasks.presetAgent"
          class="border-t border-border pt-4 flex flex-wrap items-center gap-2"
        >
          <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="saveAsDefault">
            {{ languages.AGENT_SAVE_AS_DEFAULT }}
          </Button>
          <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="resetToDefault">
            {{ languages.AGENT_RESET_TO_DEFAULT }}
          </Button>
        </div>
        <SessionSettingsActions
          v-else-if="!agentMode.sessionScoped"
          @reset="agentMode.resetPresetSettings()"
        >
          <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
            <button class="mt-4" @click="resetPresetSettings">
              <div class="svg-icon i-refresh">Reset</div>
              {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
            </button>
          </div>
        </SessionSettingsActions>
      </template>
    </AgentSettingsForm>

    <SettingsAgents v-if="agentMode.sessionScoped && !agentTasks.presetAgent" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
} from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { developerMode } from '@/assets/js/store/debugSettings'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { storeMediaToolSettings } from '@/lib/mediaToolSettings'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import ProviderSelector from '@/components/ProviderSelector.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SessionSettingsActions from '@/components/SessionSettingsActions.vue'
import AgentSettingsForm from '@/components/AgentSettingsForm.vue'
import AgentSaveBar from '@/components/AgentSaveBar.vue'
import SettingsAgents from '@/components/SettingsAgents.vue'
import SettingsSection from '@/components/SettingsSection.vue'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const oemBranding = useOemBranding()
const i18n = useI18N().state

const stepsSummary = computed(() =>
  i18n.AGENT_TASKS_STEP_COUNT.replace('{count}', String(agentMode.openSteps.length)),
)

const settingsReadOnly = computed(
  () => agentMode.sessionScoped && agentTasks.openSessionSettingsReadOnly,
)
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const textInference = useTextInference()
const cloudMode = useCloudMode()

// The capability catalog lives in the main process (it is what the Pi session is
// actually built from), so the checkbox list — including which capabilities are
// unavailable and why — is fetched rather than duplicated here.
const mediaTools = storeMediaToolSettings(textInference)
const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
  () => ({
    workspaceDir: agentMode.workspaceDir,
    embeddingModel: textInference.activeEmbeddingModel,
    mediaTools,
  }),
)

const { activeName: activeEmbeddingModelName, items: embeddingModelItems } =
  useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => textInference.embeddingBackend,
  )

// Only the enabled capabilities' commands: an extension that is not part of the
// session cannot answer them.
const capabilityCommands = computed(() =>
  capabilityCatalog.value
    .filter((capability) => agentMode.isCapabilityEnabled(capability.id))
    .flatMap((capability) => capability.commands),
)

onMounted(async () => {
  await refreshCapabilityCatalog()
})

// Game Agent's folders are the app's to create, and they stay sandboxed: a game is
// plain HTML with no build step, so a real shell would only add risk.
const isManagedWorkspace = computed(() => agentMode.agentWorkspaceKind === 'games')
const showShellOption = computed(() => !isManagedWorkspace.value && developerMode())

// Consent is stored per workspace folder, so this only ever affects the folder
// currently selected — pointing the agent elsewhere needs a fresh opt-in.
function toggleUnsandboxed(event: Event): void {
  agentMode.setUnsandboxed((event.target as HTMLInputElement).checked)
}

// Non-null service name for the DeviceSelector: only rendered for non-cloud
// backends (cloud shows ProviderSelector instead), so the fallback is inert.
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

const { items: backendItems } = useAgentBackendItems(() => agentMode.activeAgentPreset?.backends)

function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

// Model settings are textInference's, as in Chat Settings; the agent-only ones are agentMode's.
const binding: AgentSettingsBinding = reactive({
  backend: computed(() => textInference.backend),
  backendItems,
  setBackend: handleBackendChange,
  currentModel: computed(() =>
    textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
  ),
  contextSizeSupported: computed(() => textInference.contextSizeSettingSupported),
  contextSize: computed(() => textInference.contextSize),
  setContextSize: (contextSize: number) => {
    textInference.contextSize = contextSize
    textInference.markContextSizeEdited()
  },
  thinkingToggleSupported: computed(() => textInference.modelSupportsThinkingToggle),
  thinkingEnabled: computed(() => textInference.thinkingEnabled),
  setThinkingEnabled: (enabled: boolean) => {
    textInference.thinkingEnabled = enabled
  },
  planningPhaseSupported: computed(() => agentMode.planningPhaseSupported),
  planningThinkingOnly: computed(() => agentMode.effectivePlanningThinkingOnly),
  setPlanningThinkingOnly: agentMode.setPlanningThinkingOnly,
  capabilities: computed(() => agentMode.capabilities),
  setCapabilities: agentMode.setCapabilities,
  capabilityCatalog,
  embeddingModelName: activeEmbeddingModelName,
  embeddingModelItems,
  setEmbeddingModel: (modelName: string) =>
    textInference.selectEmbeddingModel(textInference.embeddingBackend, modelName),
  mediaTools,
  problems: computed(() => agentMode.settingsProblems),
  sharedWithChat: computed(() => !agentMode.sessionScoped),
})

async function pickFolder() {
  await agentMode.pickWorkspaceFolder()
}

/**
 * Back to the active agent preset's defaults: the shared model settings via
 * textInference (as in Chat Settings), plus the agent-only ones this panel adds.
 * The workspace folder, its sandbox consent and the sessions are user-owned
 * state, not preset settings, so they survive.
 */
function resetPresetSettings() {
  textInference.resetActivePresetSettings()
  agentMode.resetPresetSettings()
  void refreshCapabilityCatalog()
  toast.success('Reset to preset defaults')
}

function saveAsDefault() {
  agentMode.saveAsDefault()
  toast.success(i18n.AGENT_SAVED_AS_DEFAULT)
}

function resetToDefault() {
  agentMode.resetToDefault()
  void refreshCapabilityCatalog()
  toast.success(i18n.AGENT_RESET_TO_DEFAULT_DONE)
}

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName)
  if (result.success) {
    toast.success(`Switched to ${oemBranding.presetLabel(presetName)}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
</script>

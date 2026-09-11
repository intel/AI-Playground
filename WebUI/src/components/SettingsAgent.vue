<template>
  <div class="flex flex-col gap-6 p-1">
    <!-- Same picker as Chat Settings: agent presets are chat presets, so this is how
         the user gets back to a plain chat preset (and vice versa). -->
    <PresetSelector
      type="chat"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
    />

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

    <!-- Shell sandbox (per-workspace opt-in) -->
    <div v-if="!isManagedWorkspace" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Shell</Label>
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
    </div>

    <!-- Model settings (fully shared with chat via textInference/cloudMode) -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Backend</Label>
      <drop-down-new
        title="Select Backend"
        :value="textInference.backend"
        :items="backendItems"
        @change="handleBackendChange"
      ></drop-down-new>
    </div>
    <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
    <div
      v-if="textInference.backend === 'cloud'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">Provider</Label>
      <ProviderSelector />
    </div>
    <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
      <DeviceSelector :backend="deviceServiceName" />
    </div>
    <!-- Named like Chat Settings' model row: the picker's trigger is named after
         whichever model is selected, so the row carries the stable name saying
         what the control is for. -->
    <div
      role="group"
      :aria-label="languages.MODEL"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <!-- Same picker as Chat Settings, so an agent preset's requirements (tool
           calling, and coding for Game Agent) filter the list here too. -->
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0">
          <ModelSelector />
        </div>
        <CapabilityIcons v-if="currentModel" :model="currentModel" />
      </div>
    </div>
    <div
      v-if="textInference.contextSizeSettingSupported"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label for="agent-context-size" class="whitespace-nowrap">
        {{ languages.ANSWER_CONTEXT_SIZE }}
      </Label>
      <div class="flex items-center gap-3">
        <input
          id="agent-context-size"
          type="number"
          v-model="textInference.contextSize"
          min="512"
          max="131072"
          step="512"
          class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border"
        />
        <span v-if="textInference.contextSize < 16384" class="text-xs text-amber-500">
          Agentic sessions typically need 32k+ context.
        </span>
      </div>
    </div>
    <p class="text-xs text-muted-foreground">
      Backend, device/provider, model and context size are shared with Chat mode.
    </p>

    <!-- Thinking. Only models whose template honours enable_thinking can be told
         to stop, and only a session that thinks has anything to shorten. -->
    <div v-if="textInference.modelSupportsThinkingToggle" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Thinking</Label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :checked="textInference.thinkingEnabled"
          @change="textInference.thinkingEnabled = !textInference.thinkingEnabled"
        />
        <span class="flex flex-col">
          <span class="text-foreground">Think before acting</span>
          <span class="text-xs text-muted-foreground">
            Shared with Chat mode, where it applies to every answer.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!textInference.thinkingEnabled"
          :checked="agentMode.planningThinkingOnly"
          @change="agentMode.planningThinkingOnly = !agentMode.planningThinkingOnly"
        />
        <span class="flex flex-col">
          <span class="text-foreground" :class="{ 'opacity-50': !textInference.thinkingEnabled }">
            Reasoning only during planning
          </span>
          <span class="text-xs text-muted-foreground">
            The agent thinks while it works out what to build and stops once it starts building:
            Game Agent follows the checklist in its plan file from then on, and Quick Coder writes
            its game as a second step, after the plan. Presets that do not plan think throughout.
          </span>
        </span>
      </label>
    </div>

    <!-- Capabilities (built-in capability set + MCP servers) -->
    <div class="border-t border-border pt-4 flex flex-col gap-3">
      <Label class="whitespace-nowrap">Capabilities</Label>
      <p class="text-xs text-muted-foreground">
        What the agent is equipped with, on top of its file and shell tools. Each capability adds
        its tools and instructions to the session.
      </p>
      <div class="flex flex-col gap-2">
        <label
          v-for="capability in builtInCapabilities"
          :key="capability.id"
          class="flex items-start gap-2 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!!capability.unavailableReason"
            :checked="agentMode.isCapabilityEnabled(capability.id)"
            @change="toggleCapability(capability.id, $event)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ capability.label }}</span>
            <span class="text-xs text-muted-foreground">{{ capability.summary }}</span>
            <span v-if="capability.requires.length > 0" class="text-xs text-muted-foreground">
              Also enables: {{ capabilityLabels(capability.requires) }}
            </span>
            <span v-if="capability.unavailableReason" class="text-xs text-amber-500">
              {{ capability.unavailableReason }}
            </span>
          </span>
        </label>
      </div>

      <!-- Which workflows the media capability may use. Shown whenever the
           capability exists, including while it reports itself unavailable —
           turning every workflow off is what makes it unavailable, and this is
           where they are turned back on. -->
      <SettingsBuiltinTools v-if="hasMediaCapability" variant="media" />

      <!-- Slash commands of the enabled capabilities: sending one as a prompt is
           exactly how the agent's own input dispatches it. -->
      <div v-if="capabilityCommands.length > 0" class="flex flex-col gap-2">
        <Label class="whitespace-nowrap mt-2">Capability commands</Label>
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

      <Label class="whitespace-nowrap mt-2">MCP servers</Label>
      <div v-if="mcp.allServers.length > 0" class="flex flex-col gap-2">
        <label
          v-for="server in mcp.allServers"
          :key="server.id"
          class="flex items-start gap-2 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="agentMode.isCapabilityEnabled(mcpCapabilityId(server.id))"
            @change="toggleCapability(mcpCapabilityId(server.id), $event)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ server.name }}</span>
            <span v-if="server.instructions" class="text-xs text-muted-foreground">
              {{ server.instructions }}
            </span>
          </span>
        </label>
      </div>
      <p v-else class="text-xs text-muted-foreground italic">
        No MCP servers configured. Add one under App Settings → MCP.
      </p>
      <p class="text-xs text-amber-500">
        Changes take effect on the next turn, which starts a fresh Pi session. Attached MCP servers
        are started then too.
      </p>
    </div>

    <!-- Same reset affordance the Chat, Audio and workflow panels carry, so every
         preset offers a way back to its defaults. -->
    <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
      <button class="mt-4" @click="resetPresetSettings">
        <div class="svg-icon i-refresh">Reset</div>
        {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useProductMode } from '@/assets/js/store/productMode'
import { useMcp } from '@/assets/js/store/mcp'
import { getAgentToolSpecs } from '@/assets/js/tools/agentBridge'
import { mediaAgentHasTools } from '@/assets/js/agents/mediaAgent'
import { mcpCapabilityId } from '@/types/agentCapabilities'
import ProviderSelector from '@/components/ProviderSelector.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import * as toast from '@/assets/js/toast'

const agentMode = useAgentMode()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const textInference = useTextInference()
const backendServices = useBackendServices()
const cloudMode = useCloudMode()
const productModeStore = useProductMode()
const mcp = useMcp()

// The capability catalog lives in the main process (it is what the Pi session is
// actually built from), so the checkbox list — including which capabilities are
// unavailable and why — is fetched rather than duplicated here.
const capabilityCatalog = ref<AgentCapabilityInfo[]>([])
const builtInCapabilities = computed(() =>
  capabilityCatalog.value.filter((capability) => !capability.id.startsWith('mcp:')),
)

const hasMediaCapability = computed(() =>
  capabilityCatalog.value.some((capability) => capability.id === 'media'),
)

// Only the enabled capabilities' commands: an extension that is not part of the
// session cannot answer them.
const capabilityCommands = computed(() =>
  capabilityCatalog.value
    .filter((capability) => agentMode.isCapabilityEnabled(capability.id))
    .flatMap((capability) => capability.commands),
)

async function refreshCapabilityCatalog(): Promise<void> {
  capabilityCatalog.value = await window.electronAPI.agentMode.listCapabilities({
    workspaceDir: agentMode.workspaceDir,
    toolSpecs: getAgentToolSpecs(),
  })
}

onMounted(async () => {
  void mcp.refreshAvailableServers()
  await refreshCapabilityCatalog()
})

// Whether the media capability has anything to offer is decided in the main
// process from the tool specs, so turning its last workflow off (or back on) in
// the panel below only reaches the checkbox after re-asking.
watch(
  () => [mediaAgentHasTools(), textInference.toolDelegationEnabled],
  () => void refreshCapabilityCatalog(),
)

// Game Agent's folders are the app's to create, and they stay sandboxed: a game is
// plain HTML with no build step, so a real shell would only add risk.
const isManagedWorkspace = computed(() => agentMode.agentWorkspaceKind === 'games')

function capabilityLabels(ids: string[]): string {
  return ids
    .map((id) => capabilityCatalog.value.find((entry) => entry.id === id)?.label ?? id)
    .join(', ')
}

function toggleCapability(id: string, event: Event): void {
  agentMode.setCapabilityEnabled(id, (event.target as HTMLInputElement).checked)
}

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

// Mirrors SettingsChat's availableBackends: the preset's backends, filtered by
// product mode, plus Cloud Mode when its feature flag is on.
const availableBackends = computed<LlmBackend[]>(() => {
  const preset = agentMode.activeAgentPreset
  let base: LlmBackend[] = (preset?.backends as LlmBackend[] | undefined)?.filter(
    (b) => b !== 'cloud',
  ) ?? ['llamaCPP', 'openVINO']
  if (productModeStore.productMode === 'nvidia') {
    base = base.filter((b) => b !== 'openVINO')
  }
  if (cloudMode.isFeatureEnabled) {
    base = [...base, 'cloud']
  }
  return base
})

const backendItems = computed(() =>
  availableBackends.value.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] ?? backend,
    value: backend,
    active: isBackendRunning(backend),
  })),
)

function isBackendRunning(backend: LlmBackend): boolean {
  // Cloud Mode has no local service — it's "ready" once a provider base URL
  // is configured.
  if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
  const serviceName = backendToService[backend]
  return backendServices.info.find((s) => s.serviceName === serviceName)?.status === 'running'
}

function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

// Active model (capabilities) for the icon row next to the selector — same source
// as SettingsChat / PromptStatusBar.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

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

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName)
  if (result.success) {
    toast.success(`Switched to ${presetName}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
</script>

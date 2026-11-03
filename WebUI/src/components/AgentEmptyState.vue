<template>
  <!-- Configuration lives in the settings sidebar, model/context in the prompt
       status bar — so an empty transcript just needs a hint. -->
  <div class="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
    <img src="../assets/svg/ai-icon.svg" class="size-10 opacity-60" />
    <template v-if="emptyStateKind === 'game-agent'">
      <p class="text-sm">
        Describe the game you want — the agent writes it as a single HTML page, draws the art,
        play-tests it in a browser and saves it to your library.
      </p>
      <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
    </template>
    <template v-else-if="emptyStateKind === 'quick-coder'">
      <p class="text-sm">
        Describe the game you want — the agent plans it, then writes the whole thing into one HTML
        file. No generated art and no play-testing, so it finishes in minutes.
      </p>
      <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
    </template>
    <template v-else>
      <p class="text-sm">
        The agent works on files in this Session's folder — it can write code, run shell commands,
        debug web pages and generate media.
      </p>
      <p v-if="agentMode.workspaceDir" class="text-xs break-all">
        Workspace: <span class="text-foreground/80">{{ agentMode.workspaceDir }}</span>
      </p>
      <p class="text-xs">Configure model and tools in {{ settingsLabel }}.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import { agentEmptyStateKind } from '@/lib/presetModes'

const agentMode = useAgentMode()
const settingsLabel = useModeSettingsLabel('agent')
const emptyStateKind = computed(() => agentEmptyStateKind(agentMode.activeAgentPreset?.name))
</script>

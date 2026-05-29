<template>
  <div class="inline-flex items-center gap-3" :title="masterTitle">
    <span
      class="text-xs font-medium select-none text-foreground"
      style="line-height: 1; vertical-align: middle"
    >
      Home Agent
    </span>

    <button
      type="button"
      role="switch"
      :aria-checked="homeAgent.masterEnabled"
      :aria-label="`Home Agent: ${homeAgent.masterEnabled ? 'on' : 'off'}`"
      :title="masterTitle"
      :disabled="!isAvailable"
      class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      :class="
        isOn
          ? 'bg-primary/15 border-primary text-foreground'
          : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'
      "
      @click="homeAgent.toggleMaster()"
    >
      <span
        class="w-1.5 h-1.5 rounded-full"
        :style="{ backgroundColor: isOn ? 'var(--color-primary, #22c55e)' : 'currentColor' }"
      />
      <span class="tabular-nums">{{ homeAgent.masterEnabled ? 'On' : 'Off' }}</span>
      <span v-if="isOn && activeCount > 0" class="text-muted-foreground">
        · {{ activeCount }} {{ activeCount === 1 ? 'channel' : 'channels' }}
      </span>
    </button>

    <button
      type="button"
      title="Revisit Home Agent setup"
      aria-label="Revisit Home Agent setup"
      class="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="!isInstalled"
      @click="openSetup"
    >
      <Cog6ToothIcon class="w-4 h-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Cog6ToothIcon } from '@heroicons/vue/24/solid'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { CHANNELS } from '@/assets/js/store/channels/channelRegistry'

const homeAgent = useHomeAgent()
const setupWizard = useSetupWizard()
const backendServices = useBackendServices()

const isAvailable = computed(() => homeAgent.isAvailable)
const isInstalled = computed(
  () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.isSetUp === true,
)

const isOn = computed(() => isAvailable.value && homeAgent.masterEnabled)

const activeCount = computed(() => CHANNELS.filter((c) => homeAgent.channels[c.kind].active).length)

const masterTitle = computed(() => {
  if (!isInstalled.value)
    return 'Home Agent is not installed. Install it from App Settings → Installation Management.'
  if (!isAvailable.value) return 'Home Agent backend is starting…'
  return homeAgent.masterEnabled
    ? 'Home Agent is on — click to turn off. Enable individual channels in Setup.'
    : 'Home Agent is off — click to turn on. Enable individual channels in Setup.'
})

function openSetup() {
  void setupWizard.openHomeAgentSetup()
}
</script>

<template>
  <div class="inline-flex items-center gap-3" :title="anyTitle">
    <span
      class="text-xs font-medium select-none text-foreground"
      style="line-height: 1; vertical-align: middle"
    >
      Home Agent
    </span>

    <ChannelChip
      v-for="descriptor in CHANNELS"
      :key="descriptor.kind"
      :kind="descriptor.kind"
      :label="descriptor.displayName"
      :icon-color="descriptor.brandColor"
      :is-active="homeAgent.channels[descriptor.kind].active"
      :is-available="isAvailable"
      :is-ready="isAvailable && homeAgent.channels[descriptor.kind].verified"
      :title="titleFor(descriptor.kind)"
      @toggle="homeAgent.toggle(descriptor.kind)"
    />

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
import { computed, h } from 'vue'
import { Cog6ToothIcon } from '@heroicons/vue/24/solid'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { CHANNELS } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'

const homeAgent = useHomeAgent()
const setupWizard = useSetupWizard()
const backendServices = useBackendServices()

const isAvailable = computed(() => homeAgent.isAvailable)
const isInstalled = computed(
  () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.isSetUp === true,
)

function titleFor(kind: ChannelKind): string {
  const descriptor = CHANNELS.find((c) => c.kind === kind)
  const name = descriptor?.displayName ?? kind
  if (!isAvailable.value)
    return 'Home Agent is not installed. Install it from App Settings → Installation Management.'
  const state = homeAgent.channels[kind]
  if (!state.verified) return `Verify the ${name} connection in Setup Wizard before turning it on.`
  return state.active
    ? `${name} channel on — click to turn off.`
    : `${name} channel off — click to enable.`
}

const anyTitle = computed(() => {
  if (!isInstalled.value)
    return 'Home Agent is not installed. Install it from App Settings → Installation Management.'
  return 'Toggle a channel on/off; configure each in Setup Wizard.'
})

function openSetup() {
  void setupWizard.openHomeAgentSetup()
}

const ChannelChip = {
  props: {
    kind: { type: String, required: true },
    label: { type: String, required: true },
    iconColor: { type: String, required: true },
    isActive: { type: Boolean, required: true },
    isAvailable: { type: Boolean, required: true },
    isReady: { type: Boolean, required: true },
    title: { type: String, required: true },
  },
  emits: ['toggle'],
  setup(
    props: {
      kind: string
      label: string
      iconColor: string
      isActive: boolean
      isAvailable: boolean
      isReady: boolean
      title: string
    },
    { emit }: { emit: (e: 'toggle') => void },
  ) {
    return () =>
      h(
        'button',
        {
          role: 'switch',
          'aria-checked': props.isActive,
          'aria-label': `${props.label}: ${props.isActive ? 'on' : 'off'}`,
          title: props.title,
          disabled: !props.isAvailable || (!props.isReady && !props.isActive),
          class:
            'inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
            (props.isActive
              ? 'bg-primary/15 border-primary text-foreground'
              : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'),
          onClick: () => emit('toggle'),
        },
        [
          h('span', {
            class: 'w-1.5 h-1.5 rounded-full',
            style: { backgroundColor: props.isActive ? props.iconColor : 'currentColor' },
          }),
          props.label,
          h('span', { class: 'tabular-nums' }, props.isActive ? 'On' : 'Off'),
        ],
      )
  },
}
</script>

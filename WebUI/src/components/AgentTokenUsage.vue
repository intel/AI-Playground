<template>
  <Context
    :used-tokens="contextTokens"
    :used-tokens-unknown="contextUnknown"
    :max-tokens="contextWindow"
    :max-context-size="contextWindow"
    :usage="lastStepUsage"
    trigger-size="xs"
  >
    <template #details>
      <div class="pt-1 flex items-center justify-between">
        <span class="text-muted-foreground">Session total</span>
        <span>{{ format(sessionTokens) }}</span>
      </div>
      <div v-if="costFormatted" class="flex items-center justify-between">
        <span class="text-muted-foreground">Session cost</span>
        <span>{{ costFormatted }}</span>
      </div>
      <p class="pt-1 text-muted-foreground/80">
        Input and Output are the agent's most recent model call. The session total counts every step
        of the agentic run, so it grows far past the window — the agent compacts its context
        automatically when it fills up.
      </p>
    </template>
  </Context>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Context from '@/components/ui/context/Context.vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useTextInference } from '@/assets/js/store/textInference'

// Agent Mode reuses the chat Context widget so both modes label context the same
// way, and adds the two figures only an agentic run has: the cumulative session
// total across all steps and its cost (see store/agentMode.ts).
const agentMode = useAgentMode()
const textInference = useTextInference()

const format = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)

const contextTokens = computed(() => agentMode.contextUsage?.tokens ?? 0)

// Pi only reports the window once a session exists; until then it is the same
// window Chat would use, which is also what the next turn will hand to Pi.
const contextWindow = computed(
  () => agentMode.contextUsage?.contextWindow || textInference.effectiveContextWindow,
)

// Pi cannot estimate occupancy between a compaction and the next model response.
const contextUnknown = computed(
  () => !!agentMode.contextUsage && agentMode.contextUsage.tokens === null,
)

const lastStepUsage = computed(() => {
  const step = agentMode.lastStepUsage
  if (!step) return undefined
  return {
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    inputTokenDetails: { cacheReadTokens: step.cacheReadTokens },
  }
})

const sessionTokens = computed(() => agentMode.sessionTokens)

const costFormatted = computed(() => {
  const cost = agentMode.sessionUsage?.costUsd
  if (!cost) return ''
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cost < 1 ? 3 : 2,
  }).format(cost)
})
</script>

import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTaskStep } from '@/types/agentTaskIpc'

export type AgentSetup = {
  settings: AgentSessionSettings
  steps: readonly AgentTaskStep[]
}

/** Keys sorted and unset values dropped, so two copies of the same settings compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

/** Same settings and Step prompts; Step ids and blank Steps do not count. */
export function sameAgentSetup(a: AgentSetup, b: AgentSetup): boolean {
  const prompts = (steps: readonly AgentTaskStep[]) =>
    steps.map((step) => step.prompt.trim()).filter(Boolean)
  return (
    JSON.stringify(prompts(a.steps)) === JSON.stringify(prompts(b.steps)) &&
    JSON.stringify(canonical(a.settings)) === JSON.stringify(canonical(b.settings))
  )
}

// Single source of truth for the chat model capabilities surfaced in the UI:
// the icon row next to the selected model, the filter row in the model picker,
// and the prompt-area banner. Keep this list in sync with the model capability
// flags in `store/models.ts` / `store/textInference.ts`.
import { Eye, Brain, Wrench, type LucideIcon } from 'lucide-vue-next'

export type CapabilityKey = 'vision' | 'reasoning' | 'tools'

/** The subset of a model's flags that the capability UI reads. */
export type CapabilityFlags = {
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsToolCalling?: boolean
}

export type CapabilityDescriptor = {
  key: CapabilityKey
  /** Corresponding boolean flag on a model. */
  flag: keyof CapabilityFlags
  label: string
  tooltip: string
  /** Lucide icon. */
  icon: LucideIcon
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  {
    key: 'vision',
    flag: 'supportsVision',
    label: 'Vision',
    tooltip: 'Can understand images you attach.',
    icon: Eye,
  },
  {
    key: 'reasoning',
    flag: 'supportsReasoning',
    label: 'Reasoning',
    tooltip: 'Thinks step-by-step before answering.',
    icon: Brain,
  },
  {
    key: 'tools',
    flag: 'supportsToolCalling',
    label: 'Tool calling',
    tooltip: 'Can call built-in and MCP tools / functions.',
    icon: Wrench,
  },
]

export function modelHasCapability(
  model: CapabilityFlags | null | undefined,
  key: CapabilityKey,
): boolean {
  if (!model) return false
  const descriptor = CAPABILITIES.find((c) => c.key === key)
  return !!descriptor && model[descriptor.flag] === true
}

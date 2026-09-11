import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../../logging/logger.ts'
import { jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import type { ResolvedCapability } from './types.ts'

// ── The capabilities meta-tool ───────────────────────────────────────────────
//
// Only used when the activation policy keeps capabilities dormant (small context
// windows). Dormant capabilities are
// registered with Pi but not in the active tool set, so their schemas cost
// nothing until the model asks for them.
//
// Activation is sticky: `setActiveTools` makes Pi rebuild the system prompt,
// which invalidates the whole prompt cache and re-processes the conversation, so
// a capability is activated at most once and never deactivated.

const logger = appLoggerInstance
const LOG_SOURCE = 'capabilities/core'

export const CAPABILITIES_TOOL_NAME = 'capabilities'

const CAPABILITIES_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'activate'],
      description:
        'list: show every capability in this session and whether its tools are loaded; ' +
        'activate: load a capability\u2019s tools so you can call them.',
    },
    id: {
      type: 'string',
      description: 'Capability id to activate (required for action=activate).',
    },
  },
  required: ['action'],
}

export type CoreCapabilityExtension = {
  factory: ExtensionFactory
  /** Prompt text describing the dormant capabilities, or '' when there are none. */
  promptSection: string
}

/**
 * The one-line-per-capability block that replaces dormant tool schemas in the
 * system prompt: enough for the model to know the functionality exists, at a
 * fraction of the tokens.
 */
export function dormantCapabilitiesPromptSection(dormant: ResolvedCapability[]): string {
  if (dormant.length === 0) return ''
  const lines = [
    'Additional capabilities exist in this session but their tools are not loaded yet, to keep',
    'the context small. Load one with the `capabilities` tool',
    '({"action":"activate","id":"<id>"}) before using it; it stays loaded afterwards.',
    '',
    '<dormant_capabilities>',
  ]
  for (const { capability } of dormant) {
    lines.push(`  <capability id="${capability.id}">${capability.summary}</capability>`)
  }
  lines.push('</dormant_capabilities>')
  return lines.join('\n')
}

/**
 * The extension that owns dormant-capability activation. `resolved` is every
 * capability in the session (active and dormant) so `list` can describe all of
 * them, `dormant` the subset whose tools still need activating.
 */
export function createCapabilitiesExtension(options: {
  resolved: ResolvedCapability[]
  dormant: ResolvedCapability[]
  /** Where the model can read a capability's skills, per capability id. */
  skillLocations: Record<string, string[]>
}): CoreCapabilityExtension {
  const { resolved, dormant, skillLocations } = options
  const dormantById = new Map(dormant.map((entry) => [entry.capability.id, entry]))

  const describe = (pi: ExtensionAPI): string => {
    const active = new Set(pi.getActiveTools())
    const lines = resolved.map(({ capability, tools }) => {
      const loaded = tools.length === 0 || tools.every((tool) => active.has(tool.name))
      const state = loaded ? 'loaded' : 'not loaded'
      const toolList = tools.length > 0 ? ` tools: ${tools.map((t) => t.name).join(', ')};` : ''
      return `- ${capability.id} (${state}):${toolList} ${capability.summary}`
    })
    return lines.length > 0 ? lines.join('\n') : 'No capabilities are enabled in this session.'
  }

  const activate = (pi: ExtensionAPI, id: string): string => {
    const entry = dormantById.get(id)
    if (!entry) {
      const known = resolved.map(({ capability }) => capability.id).join(', ')
      // Already-active capabilities land here too, which is the right answer:
      // there is nothing to do and the tools are callable.
      return `No dormant capability with id "${id}". Available capabilities: ${known || 'none'}.`
    }
    dormantById.delete(id)
    const toolNames = entry.tools.map((tool) => tool.name)
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])])
    logger.info(`activated capability '${id}' (${toolNames.join(', ') || 'no tools'})`, LOG_SOURCE)
    const skills = skillLocations[id] ?? []
    return [
      `Activated "${id}". ${entry.capability.summary}`,
      toolNames.length > 0
        ? `Its tools are now callable: ${toolNames.join(', ')}.`
        : 'It contributes instructions only, no tools.',
      ...(skills.length > 0 ? [`Read ${skills.join(' and ')} for how to use it.`] : []),
    ].join(' ')
  }

  const factory: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: CAPABILITIES_TOOL_NAME,
      label: CAPABILITIES_TOOL_NAME,
      description:
        'List the extra capabilities available in this session and load one so its tools ' +
        'become callable. Use it before attempting a task a dormant capability covers.',
      parameters: jsonSchemaParameters(CAPABILITIES_INPUT_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { action, id } = params as { action?: string; id?: string }
        if (action === 'activate') {
          if (!id) return textResult('activate needs an "id". Call {"action":"list"} first.')
          return textResult(activate(pi, id))
        }
        return textResult(describe(pi))
      },
    })
  }

  return { factory, promptSection: dormantCapabilitiesPromptSection(dormant) }
}

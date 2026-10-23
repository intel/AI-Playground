import { z, type ZodType } from 'zod'
import type { ToolSet } from 'ai'
import type { ChatToolSpec } from '@/types/chatIpc'

// ── Serializing a turn's tool catalog for main ────────────────────────────────
//
// Tool bodies run in main (`electron/chat/turnEngine.ts` and the per-tool
// modules beside it); the renderer's job is to decide which tools this turn
// offers and to describe them. That description crosses as plain JSON Schema
// with the turn request, so main can validate a tool call and hand the model a
// catalog without importing anything from here.
//
// This file used to also run the bodies, over a `chat:executeTool` round trip.
// Nothing needs that any more: what genuinely belongs to the window (consent,
// the speech engine, a confirmation card) is asked for by name over `chat:ask`
// instead of by handing a whole tool back.

/** Best-effort zod → JSON Schema; permissive fallback keeps a turn alive. */
function serializeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object') {
    const asRecord = schema as Record<string, unknown>
    // provider-utils jsonSchema() wrapper (MCP tools): raw schema rides inside.
    if (asRecord.jsonSchema && typeof asRecord.jsonSchema === 'object') {
      return asRecord.jsonSchema as Record<string, unknown>
    }
    if (typeof (asRecord as { safeParse?: unknown }).safeParse === 'function') {
      try {
        return z.toJSONSchema(schema as ZodType) as Record<string, unknown>
      } catch (error) {
        console.error('Failed to serialize tool input schema:', error)
        return { type: 'object' }
      }
    }
    return asRecord
  }
  return { type: 'object' }
}

/**
 * A ToolSet as the turn request ships it: pure data, no execute closures.
 */
export function serializeToolSet(toolSet: ToolSet): ChatToolSpec[] {
  const specs: ChatToolSpec[] = []
  for (const [name, tool] of Object.entries(toolSet)) {
    const record = tool as unknown as { description?: string; inputSchema?: unknown }
    specs.push({
      name,
      description: record.description ?? '',
      inputSchema: serializeInputSchema(record.inputSchema),
    })
  }
  return specs
}

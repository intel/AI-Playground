import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  jsonResult,
  jsonSchemaParameters,
  saveGeneratedMediaToWorkspace,
  workspaceFileToDataUri,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentToolSpec, CapabilityHost } from './types.ts'
import { condenseMediaAgentRun, slimCondensedMedia } from '@/lib/mediaAgentResult'
import type { ChatModelConfig } from '@/types/chatIpc'

// ── media delegation tool ────────────────────────────────────────────────────
//
// The thin `media` tool: the model describes the desired result in natural
// language and a media specialist (nested AI SDK run in
// electron/chat/mediaAgentRunner.ts) picks workflows and parameters and can
// chain steps. Inner Comfy tools run in-process against the Artifact runner
// (step 12). The renderer only ships the live catalog on the turn; screenshot
// / web-browse stay on the renderer bridge.

export type MediaSpecialistTurn = {
  mediaAgent: NonNullable<CapabilityHost['mediaAgent']>
  chatModel: ChatModelConfig
  keepModelsLoaded: boolean
}

let live: MediaSpecialistTurn | null = null

/** Latest turn's specialist payload — session reuse must not freeze the catalog. */
export function setMediaSpecialistTurn(next: MediaSpecialistTurn | null): void {
  live = next
}

export function resetMediaSpecialistTurnForTest(): void {
  live = null
}

function resolveSpecialist(host: CapabilityHost): MediaSpecialistTurn | null {
  if (live?.mediaAgent && live.chatModel) return live
  if (host.mediaAgent && host.chatModel) {
    return {
      mediaAgent: host.mediaAgent,
      chatModel: host.chatModel,
      keepModelsLoaded: host.keepModelsLoaded,
    }
  }
  return null
}

function sourceImageFromInput(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : undefined
}

/** Builds the in-process `media` tool for one shipped spec. */
export async function buildDelegatedMediaTool(
  host: CapabilityHost,
  spec: AgentToolSpec,
): Promise<ToolDefinition> {
  const pi = await loadPi()
  const { workspaceDir } = host
  return pi.defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: jsonSchemaParameters(spec.inputSchema),
    execute: async (toolCallId, params, signal) => {
      const dispatchInput = { ...(params as Record<string, unknown>) }
      for (const key of spec.workspacePathInputs ?? []) {
        const value = dispatchInput[key]
        if (typeof value === 'string' && value !== '') {
          dispatchInput[key] = workspaceFileToDataUri(workspaceDir, value)
        }
      }
      const specialist = resolveSpecialist(host)
      if (!specialist) {
        throw new Error('Media specialist is not configured for this turn')
      }
      const request = String(dispatchInput.request ?? '')
      const { runMediaAgentInMain } = await import('../../chat/mediaAgentRunner.ts')
      const raw = await runMediaAgentInMain(
        {
          runKey: toolCallId || `media-run:${crypto.randomUUID()}`,
          // The turn that is awaiting this call occupies the GPU as text; without
          // its key the nested run waits for that occupancy to clear and deadlocks.
          conversationKey: host.sessionId,
          origin: 'agent',
          request,
          sourceImage: sourceImageFromInput(dispatchInput.sourceImagePath),
          system: specialist.mediaAgent.system,
          model: specialist.chatModel,
          toolSpecs: specialist.mediaAgent.toolSpecs,
          repairData: specialist.mediaAgent.repairData,
          keepModelsLoaded: specialist.keepModelsLoaded,
        },
        signal ?? undefined,
      )
      const condensed = condenseMediaAgentRun(raw)
      const saved = await saveGeneratedMediaToWorkspace(slimCondensedMedia(condensed), workspaceDir)
      return jsonResult(saved)
    },
  }) as ToolDefinition
}

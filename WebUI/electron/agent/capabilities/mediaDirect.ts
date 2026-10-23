import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  jsonResult,
  jsonSchemaParameters,
  saveGeneratedMediaToWorkspace,
  workspaceFileToDataUri,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentToolSpec, CapabilityHost } from './types.ts'
import {
  runInProcessComfyTool,
  setMediaCatalogProvider,
  resetMediaCatalogProviderForTest,
  type InProcessComfyArgs,
} from '../../artifact/inProcessComfy.ts'

export { setMediaCatalogProvider, resetMediaCatalogProviderForTest }

// ── direct media tools, in-process ────────────────────────────────────────────
//
// `generateImage` / `editImage` executed beside the artifact runner in main
// (architecture-target §8 step 5): workflow resolution and the GPU queue live
// in `inProcessComfy.ts`, shared with the NL media specialist's inner Comfy
// tools (step 12). Only the specs are still shipped by the renderer.

type DirectArgs = InProcessComfyArgs & { sourceImagePath?: unknown }

async function runDirectTool(
  host: CapabilityHost,
  spec: AgentToolSpec,
  rawArgs: DirectArgs,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const isEdit = spec.name === 'editImage'
  return await runInProcessComfyTool({
    kind: isEdit ? 'edit' : 'create',
    args: { ...rawArgs, defaultWorkflow: spec.defaultWorkflow },
    source: isEdit ? (rawArgs.sourceImagePath as string | undefined) : undefined,
    origin: 'agent',
    ...(toolCallId ? { owner: { kind: 'tool' as const, toolCallId } } : {}),
    // The turn that is awaiting this call occupies the GPU as text; without its
    // key the nested run waits for that occupancy to clear and deadlocks.
    conversationKey: host.sessionId,
    keepModelsLoaded: host.keepModelsLoaded,
    signal,
  })
}

/** Builds the in-process `generateImage` / `editImage` tools for the shipped specs. */
export async function buildDirectMediaTools(
  host: CapabilityHost,
  specs: AgentToolSpec[],
): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  const { workspaceDir } = host
  return Promise.all(
    specs.map(
      (spec) =>
        pi.defineTool({
          name: spec.name,
          label: spec.name,
          description: spec.description,
          parameters: jsonSchemaParameters(spec.inputSchema),
          execute: async (toolCallId, params, signal) => {
            const args = { ...(params as DirectArgs) }
            for (const key of spec.workspacePathInputs ?? []) {
              const value = args[key as keyof DirectArgs]
              if (typeof value === 'string' && value !== '') {
                ;(args as Record<string, unknown>)[key] = workspaceFileToDataUri(
                  workspaceDir,
                  value,
                )
              }
            }
            const result = await runDirectTool(host, spec, args, toolCallId, signal ?? undefined)
            return jsonResult(await saveGeneratedMediaToWorkspace(result, workspaceDir))
          },
        }) as ToolDefinition,
    ),
  )
}

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  executeToolInRenderer,
  jsonResult,
  jsonSchemaParameters,
  saveGeneratedMediaToWorkspace,
  workspaceFileToDataUri,
  type SkillSource,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

// ── media capability ─────────────────────────────────────────────────────────
//
// The AIPG media tools (image/video/3D generation and editing). Their
// implementations live in the RENDERER, where the Pinia stores driving ComfyUI
// are, so these Pi tools are proxies: main resolves workspace paths to data
// URIs on the way in, dispatches over IPC, and saves generated media into the
// workspace on the way out.
//
// Which tools exist is decided by the renderer and shipped with the turn as
// `toolSpecs` (one thin `media` delegation tool, or generateImage + editImage
// when tool delegation is off), so this capability is unavailable when the
// renderer has no media workflows to offer.

const MEDIA_GENERATION_SKILL: SkillSource = {
  name: 'media-generation',
  description:
    'Create or transform images, videos and 3D models with the `media` tool; results are ' +
    'saved into the workspace.',
  body: [
    'The `media` tool hands your request to a media specialist that picks the right generation',
    'workflow and parameters. Use it like this:',
    '',
    '1. Describe the desired result in ONE natural-language request: subject, style, aspect',
    '   ratio / size wishes, and quality level. Terse prompts are expanded automatically.',
    '2. Multi-step requests belong in a single call — e.g. "generate an image of a castle and',
    '   turn it into a 3D model" or "animate this photo into a short video". Do not split them',
    '   into separate calls; the specialist chains the steps itself.',
    '3. To transform an image that already exists in the workspace, pass its workspace-relative',
    '   path as sourceImagePath (e.g. "generated/AIPG_00001_.png").',
    '4. The result lists what was created plus "savedFiles": the workspace-relative paths of the',
    '   generated media under "generated/". Reference those paths in your reply or in files you',
    '   write (e.g. an <img src="generated/...png"> in an HTML page).',
    '',
    'Media generation takes minutes — call the tool once, then wait for its result. Do not',
    'retry while a call is running.',
  ].join('\n'),
}

/** Pi tool definitions proxying to the renderer implementations. */
async function buildBridgedTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  const { workspaceDir } = host
  return host.toolSpecs.map(
    (spec) =>
      pi.defineTool({
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
          const result = await executeToolInRenderer(
            spec.name,
            dispatchInput,
            toolCallId,
            signal ?? undefined,
          )
          return jsonResult(await saveGeneratedMediaToWorkspace(result, workspaceDir))
        },
      }) as ToolDefinition,
  )
}

export const mediaCapability: AgentCapability = {
  id: 'media',
  label: 'Media generation',
  summary:
    'Generate and transform images, videos and 3D models; results are saved into the workspace.',
  skills: [MEDIA_GENERATION_SKILL],
  buildTools: buildBridgedTools,
  unavailableReason: (host) =>
    host.toolSpecs.length === 0
      ? 'No image or video workflows are installed — install a ComfyUI workflow first.'
      : undefined,
  lazyEligible: true,
}

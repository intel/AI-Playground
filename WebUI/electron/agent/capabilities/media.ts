import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCapability, CapabilityHost } from './types.ts'
import type { SkillSource } from '../piCustomTools.ts'
import { buildDelegatedMediaTool } from './mediaDelegation.ts'
import { buildDirectMediaTools } from './mediaDirect.ts'
import { buildSpeechTools, SPEECH_TOOL_NAMES } from './mediaSpeech.ts'

// ── media capability ─────────────────────────────────────────────────────────
//
// The AIPG media tools (image/video/3D generation and editing, plus speech).
// Which tools exist is decided by the renderer and shipped with the turn as
// `toolSpecs`: one thin `media` delegation tool when tool delegation is on, else
// generateImage + editImage, and the speech tools the preset has enabled. Direct
// tools and the NL specialist's inner Comfy tools both execute in-process
// against the Artifact runner (steps 5 and 12); speech calls the engine through
// the window (mediaSpeech.ts). Screenshot / web-browse stay on the renderer
// bridge.

// Every path in here is described, never shown: a concrete `generated/<file>`
// example reads like a result the model already has, and it passes that example
// on — to `set_icon`, to an <img src> — instead of calling the tool. When the
// file then turns out not to exist, the shell looks like the way to fix it.
const PATHS_ARE_REPORTED = [
  'The generator names the files, so a path under "generated/" exists only once a call has',
  'reported it. Never guess one, and never produce an image file yourself with `write` or the',
  'shell — a file you compose by hand is not a picture.',
  '',
  'Media generation takes minutes — call the tool once, then wait for its result. Do not',
  'retry while a call is running.',
]

const DELEGATED_BODY = [
  'The `media` tool hands your request to a media specialist that picks the right generation',
  'workflow and parameters. Use it like this:',
  '',
  '1. Describe the desired result in ONE natural-language request: subject, style, aspect',
  '   ratio / size wishes, and quality level. Terse prompts are expanded automatically.',
  '2. Multi-step requests belong in a single call — e.g. "generate an image of a castle and',
  '   turn it into a 3D model" or "animate this photo into a short video". Do not split them',
  '   into separate calls; the specialist chains the steps itself.',
  '3. To transform an image that already exists in the workspace, pass its workspace-relative',
  '   path as sourceImagePath: one an earlier call reported, or a file the user attached',
  '   under "attachments/".',
  '4. The result lists what was created plus "savedFiles": the workspace-relative paths of the',
  '   generated media under "generated/". Reference those paths in your reply or in files you',
  '   write (e.g. an <img src="generated/...png"> in an HTML page).',
  '',
]

const DIRECT_BODY = [
  '`generateImage` creates an image from a prompt. `editImage` transforms one that already',
  'exists, named by its workspace-relative `sourceImagePath` — a path an earlier call reported,',
  'or a file the user attached under "attachments/". Chaining is yours to do: generate first,',
  'then edit the path that came back.',
  '',
  'Describe the desired result in the prompt: subject, style, aspect ratio / size wishes and',
  'quality level. Each result lists what it produced under "savedFiles", saved into',
  '"generated/". Reference those paths in your reply or in files you write (e.g. an',
  '<img src="generated/...png"> in an HTML page).',
  '',
]

function mediaGenerationSkill(delegated: boolean): SkillSource {
  const tools = delegated ? 'the `media` tool' : '`generateImage` / `editImage`'
  return {
    name: 'media-generation',
    description:
      `Create or transform images, videos and 3D models with ${tools}; results are ` +
      'saved into the workspace.',
    body: [...(delegated ? DELEGATED_BODY : DIRECT_BODY), ...PATHS_ARE_REPORTED].join('\n'),
  }
}

// Speech is not a ComfyUI workflow, so the specialist cannot pick it up: the
// tools are the agent's own, and saying so here is what keeps a model from
// hunting for espeak/piper on the shell when asked for audio.
const SPEECH_SKILL = {
  name: 'speech-audio',
  description:
    'Speak text aloud into an audio file with `synthesizeTextToSpeech`, and turn an audio ' +
    "file into text with `transcribeAudio`, using the app's local speech engines.",
  body: [
    'Audio does NOT go through the `media` tool or a ComfyUI workflow, and there is no speech',
    'binary on the shell. The two speech tools are the only way to produce or read audio.',
    '',
    '- `synthesizeTextToSpeech` speaks `text` and writes the clip into "generated/"; its',
    '  workspace-relative path comes back as "savedFilePath". Pass the whole passage in one',
    '  call rather than chunking it, and pick a voice with `speaker` (or `instruct` for a',
    '  described one, or `voiceName` for one the user has saved).',
    '- `transcribeAudio` needs `sourceAudioPath`, a workspace-relative path (wav, mp3, m4a,',
    '  ogg, flac, webm).',
    '',
    'The first call of a session may load a voice model, which takes a while — call the tool',
    'once and wait for its result.',
  ].join('\n'),
} as const

const DELEGATION_TOOL_NAME = 'media'
const DIRECT_TOOL_NAMES = new Set(['generateImage', 'editImage'])

/** How this turn generates media: the delegation tool, the direct pair, or neither. */
export function mediaToolNames(host: CapabilityHost): string[] {
  return host.toolSpecs
    .map((spec) => spec.name)
    .filter((name) => name === DELEGATION_TOOL_NAME || DIRECT_TOOL_NAMES.has(name))
}

/** Routes each shipped spec to its executor: delegation proxy, in-process run or speech. */
async function buildMediaTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const delegationSpecs = host.toolSpecs.filter((spec) => spec.name === DELEGATION_TOOL_NAME)
  const directSpecs = host.toolSpecs.filter((spec) => DIRECT_TOOL_NAMES.has(spec.name))
  const speechSpecs = host.toolSpecs.filter((spec) => SPEECH_TOOL_NAMES.has(spec.name))
  return [
    ...(await buildDirectMediaTools(host, directSpecs)),
    ...(await Promise.all(delegationSpecs.map((spec) => buildDelegatedMediaTool(host, spec)))),
    ...(await buildSpeechTools(host, speechSpecs)),
  ]
}

export const mediaCapability: AgentCapability = {
  id: 'media',
  label: 'Media generation',
  summary:
    'Generate and transform images, videos and 3D models, and speak or transcribe audio; ' +
    'results are saved into the workspace.',
  // Built per turn: the skill has to name the tools this turn registered, which
  // the tool-delegation setting decides.
  buildSkills: (host) => {
    const generation = mediaToolNames(host)
    return [
      ...(generation.length > 0
        ? [mediaGenerationSkill(generation.includes(DELEGATION_TOOL_NAME))]
        : []),
      ...(host.toolSpecs.some((spec) => SPEECH_TOOL_NAMES.has(spec.name)) ? [SPEECH_SKILL] : []),
    ]
  },
  buildTools: buildMediaTools,
  unavailableReason: (host) =>
    host.toolSpecs.length === 0
      ? 'No media tools are enabled — install or enable a ComfyUI workflow, or switch on a speech tool.'
      : undefined,
  lazyEligible: true,
}

import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { jsonResult, jsonSchemaParameters, resolveWorkspaceFile } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { askRenderer } from '../../chat/chatAsk.ts'
import { saveGeneratedAudioFile } from '../../persist/audioFiles.ts'
import { noteGeneratedMedia } from '../generatedMedia.ts'
import { buildTtsAudioFileName } from '@/lib/ttsAudioFileName'
import type { AgentMediaDetails } from '@/types/agentMediaDetails'
import type { SpeechClipPayload, SpeechVoiceSelection } from '@/types/chatRequests'
import { NOTIFY_USER_TOOL } from './notify.ts'
import type { AgentToolSpec, CapabilityHost } from './types.ts'

// ── speech tools for an agent turn ───────────────────────────────────────────
//
// `synthesizeTextToSpeech` / `transcribeAudio`, shaped for a workspace instead
// of a conversation: the clip lands in `<workspace>/generated/` for the agent and
// in the app's audio folder for the transcript, and the file to transcribe is
// named by workspace path because an agent turn has no message history to find
// an attachment in. The
// engine call itself is the window's either way, over the same `chat:ask` seam
// the chat bodies use (chat/chatSpeechTools.ts).

export const SPEECH_TOOL_NAMES = new Set(['synthesizeTextToSpeech', 'transcribeAudio'])

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

const CLIP_EXT_BY_MIME: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
}

type SynthesizeArgs = SpeechVoiceSelection & { text?: unknown; outputFileName?: unknown }

function fileStem(userSlug: unknown): string {
  const raw = typeof userSlug === 'string' ? userSlug : ''
  const slug = raw
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^[_.\-]+|[_.\-]+$/g, '')
    .slice(0, 40)
  return slug || 'speech'
}

/** A free path under `<workspace>/generated/`, so a second take never overwrites the first. */
function generatedAudioPath(
  workspaceDir: string,
  stem: string,
  extension: string,
): { fullPath: string; relativePath: string } {
  const dir = path.join(workspaceDir, 'generated')
  fs.mkdirSync(dir, { recursive: true })
  let name = `${stem}${extension}`
  for (let n = 1; fs.existsSync(path.join(dir, name)); n++) {
    name = `${stem}_${n}${extension}`
  }
  return { fullPath: path.join(dir, name), relativePath: path.posix.join('generated', name) }
}

/** A game's clip also lands in its Session's `files/`, which is what the Session shows. */
async function copyIntoSession(host: CapabilityHost, fullPath: string): Promise<string[]> {
  if (host.sessionMedia?.workspace !== 'game') return []
  const { filesDir } = host.sessionMedia
  await fs.promises.mkdir(filesDir, { recursive: true })
  const target = path.join(filesDir, path.basename(fullPath))
  await fs.promises.copyFile(fullPath, target)
  return [target]
}

function describeClip(clip: SpeechClipPayload): string {
  if (clip.engine === 'qwen3') {
    return `Synthesized ${clip.mode} speech (${clip.language}, ${clip.voice}).`
  }
  const engine = clip.engine === 'kokoro' ? 'Kokoro' : 'the external endpoint'
  return `Synthesized speech with ${engine} (${clip.voice}).`
}

function failure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

type SpeechResult = { output: unknown; details?: AgentMediaDetails }

async function synthesize(
  host: CapabilityHost,
  params: unknown,
  signal?: AbortSignal,
): Promise<SpeechResult> {
  const args = (params ?? {}) as SynthesizeArgs
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) return { output: { ok: false, message: 'No text to speak.' } }
  try {
    const clip = await askRenderer<SpeechClipPayload>(
      {
        kind: 'speech-synthesize',
        text,
        voice: {
          speaker: args.speaker,
          language: args.language,
          mode: args.mode,
          instruct: args.instruct,
          voiceName: args.voiceName,
          rememberAsDefault: args.rememberAsDefault,
        },
      },
      { abortSignal: signal, conversationKey: host.sessionId },
    )
    if (!clip.audioBase64)
      return { output: { ok: false, message: 'The speech engine returned no audio.' } }
    const stem = fileStem(args.outputFileName)
    const { fullPath, relativePath } = generatedAudioPath(
      host.workspaceDir,
      stem,
      CLIP_EXT_BY_MIME[clip.mediaType] ?? '.wav',
    )
    await fs.promises.writeFile(fullPath, Buffer.from(clip.audioBase64, 'base64'))
    noteGeneratedMedia(host.workspaceDir, [relativePath], await copyIntoSession(host, fullPath))
    const appCopyPath = await saveGeneratedAudioFile(
      clip.audioBase64,
      buildTtsAudioFileName({
        conversationKey: host.sessionId,
        conversationLabel: path.basename(host.workspaceDir),
        userSlug: stem,
      }),
    )
    const message = `${describeClip(clip)} Saved into the workspace at ${relativePath}.`
    const toAgent =
      `${message} To send it to the user, call ${NOTIFY_USER_TOOL} with ` +
      `"attachments": ["${relativePath}"]; do not mention its path, which they cannot open.`
    return {
      output: {
        ok: true,
        message: toAgent,
        savedFilePath: relativePath,
        speaker: clip.voice,
        ...(clip.engine === 'qwen3' ? { language: clip.language, mode: clip.mode } : {}),
      },
      details: { audio: { savedFilePath: appCopyPath, workspacePath: relativePath, message } },
    }
  } catch (error) {
    return { output: failure(error) }
  }
}

async function transcribeWorkspaceAudio(
  host: CapabilityHost,
  params: unknown,
  signal?: AbortSignal,
): Promise<SpeechResult> {
  const raw = (params ?? {}) as { sourceAudioPath?: unknown }
  const relativePath = typeof raw.sourceAudioPath === 'string' ? raw.sourceAudioPath.trim() : ''
  if (!relativePath) {
    return {
      output: {
        ok: false,
        message: 'No sourceAudioPath given — pass the workspace-relative path of an audio file.',
      },
    }
  }
  try {
    const fullPath = resolveWorkspaceFile(host.workspaceDir, relativePath)
    const mediaType = AUDIO_MIME_BY_EXT[path.extname(fullPath).toLowerCase()]
    if (!mediaType) throw new Error(`Unsupported audio file type: ${relativePath}`)
    const { text } = await askRenderer<{ text: string }>(
      {
        kind: 'speech-transcribe',
        audioBase64: (await fs.promises.readFile(fullPath)).toString('base64'),
        mediaType,
      },
      { abortSignal: signal, conversationKey: host.sessionId },
    )
    return { output: { ok: true, message: `Transcribed ${relativePath}.`, transcript: text } }
  } catch (error) {
    return { output: failure(error) }
  }
}

/** Builds the workspace-flavoured speech tools for the shipped specs. */
export async function buildSpeechTools(
  host: CapabilityHost,
  specs: AgentToolSpec[],
): Promise<ToolDefinition[]> {
  if (specs.length === 0) return []
  const pi = await loadPi()
  return specs.map(
    (spec) =>
      pi.defineTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: jsonSchemaParameters(spec.inputSchema),
        execute: async (_toolCallId, params, signal) => {
          const run = spec.name === 'synthesizeTextToSpeech' ? synthesize : transcribeWorkspaceAudio
          const { output, details } = await run(host, params, signal ?? undefined)
          return { ...jsonResult(output), details }
        },
      }) as ToolDefinition,
  )
}

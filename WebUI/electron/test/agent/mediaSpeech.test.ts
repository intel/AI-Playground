import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { AgentToolSpec } from '@/types/agentIpc'
import type { AgentMediaDetails } from '@/types/agentMediaDetails'

// The agent's speech tools (capabilities/mediaSpeech.ts): the engine call is the
// window's, over the same `chat:ask` seam the chat bodies use, and what differs
// is the workspace — the clip is written under `generated/` and the file to
// transcribe is named by workspace-relative path.

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

let audioDir: string
vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAudioDir: () => audioDir,
}))

const askRendererMock = vi.fn()
vi.mock('../../chat/chatAsk.ts', () => ({ askRenderer: askRendererMock }))

const { buildSpeechTools } = await import('../../agent/capabilities/mediaSpeech.ts')

const SYNTHESIZE_SPEC: AgentToolSpec = {
  name: 'synthesizeTextToSpeech',
  description: 'speak text',
  inputSchema: { type: 'object' },
}

const TRANSCRIBE_SPEC: AgentToolSpec = {
  name: 'transcribeAudio',
  description: 'transcribe audio',
  inputSchema: { type: 'object' },
}

type BuiltTool = {
  name: string
  execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
}

let workspaceDir: string

async function buildTool(
  spec: AgentToolSpec,
  overrides: Record<string, unknown> = {},
): Promise<BuiltTool> {
  const host = {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [spec],
    agentDir: workspaceDir,
    keepModelsLoaded: false,
    ...overrides,
  }
  const [tool] = (await buildSpeechTools(host, [spec])) as unknown as BuiltTool[]
  return tool
}

function parseOutput(output: unknown): Record<string, unknown> {
  const result = output as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0].text)
}

function detailsOf(output: unknown): AgentMediaDetails | undefined {
  return (output as { details?: AgentMediaDetails }).details
}

function run(tool: BuiltTool, params: unknown): Promise<Record<string, unknown>> {
  return tool
    .execute('call-1', params, new AbortController().signal)
    .then((output) => parseOutput(output))
}

describe('mediaSpeech (agent speech tools)', () => {
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-speech-'))
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-speech-audio-'))
    askRendererMock.mockReset()
  })

  it('writes the clip into the workspace and reports its relative path', async () => {
    askRendererMock.mockResolvedValue({
      audioBase64: Buffer.from('riff').toString('base64'),
      mediaType: 'audio/wav',
      voice: 'Vivian',
      engine: 'qwen3',
      mode: 'custom_voice',
      language: 'German',
    })
    const tool = await buildTool(SYNTHESIZE_SPEC)

    const output = await run(tool, { text: 'Die wichtigsten Meldungen', speaker: 'Vivian' })

    expect(askRendererMock.mock.calls[0][0]).toMatchObject({
      kind: 'speech-synthesize',
      text: 'Die wichtigsten Meldungen',
      voice: { speaker: 'Vivian' },
    })
    expect(output).toMatchObject({ ok: true, savedFilePath: 'generated/speech.wav' })
    expect(fs.readFileSync(path.join(workspaceDir, 'generated', 'speech.wav'), 'utf8')).toBe('riff')
  })

  it('tells the agent to attach the clip to a Notification rather than mention its path', async () => {
    askRendererMock.mockResolvedValue({
      audioBase64: Buffer.from('riff').toString('base64'),
      mediaType: 'audio/wav',
      voice: 'Ryan',
      engine: 'kokoro',
    })
    const tool = await buildTool(SYNTHESIZE_SPEC)

    const output = await run(tool, { text: 'hello' })

    expect(output.message).toContain('notify_user')
    expect(output.message).toContain('"attachments": ["generated/speech.wav"]')
    expect(output.message).toMatch(/not .*path/i)
  })

  it('also keeps an app-folder copy for the transcript, which outlives the workspace', async () => {
    askRendererMock.mockResolvedValue({
      audioBase64: Buffer.from('riff').toString('base64'),
      mediaType: 'audio/wav',
      voice: 'Ryan',
      engine: 'kokoro',
    })
    const tool = await buildTool(SYNTHESIZE_SPEC)

    const output = await tool.execute('call-1', { text: 'hello' }, new AbortController().signal)

    expect(parseOutput(output)).toEqual({
      ok: true,
      message: expect.stringContaining(
        'Synthesized speech with Kokoro (Ryan). Saved into the workspace at generated/speech.wav.',
      ),
      savedFilePath: 'generated/speech.wav',
      speaker: 'Ryan',
    })
    const audio = detailsOf(output)?.audio
    expect(audio?.workspacePath).toBe('generated/speech.wav')
    expect(path.dirname(audio!.savedFilePath)).toBe(audioDir)
    fs.rmSync(workspaceDir, { recursive: true })
    expect(fs.readFileSync(audio!.savedFilePath, 'utf8')).toBe('riff')
  })

  it('gives a failed synthesis no details', async () => {
    askRendererMock.mockRejectedValueOnce(new Error('no voice model'))
    const tool = await buildTool(SYNTHESIZE_SPEC)

    const output = await tool.execute('call-1', { text: 'hello' }, new AbortController().signal)

    expect(detailsOf(output)).toBeUndefined()
  })

  it('names the clip after outputFileName and never overwrites a take', async () => {
    askRendererMock.mockResolvedValue({
      audioBase64: Buffer.from('a').toString('base64'),
      mediaType: 'audio/wav',
      voice: 'Ryan',
      engine: 'kokoro',
    })
    const tool = await buildTool(SYNTHESIZE_SPEC)

    const first = await run(tool, { text: 'one', outputFileName: 'news summary.wav' })
    const second = await run(tool, { text: 'two', outputFileName: 'news summary' })

    expect(first.savedFilePath).toBe('generated/news_summary.wav')
    expect(second.savedFilePath).toBe('generated/news_summary_1.wav')
  })

  it("keeps a game Session's earlier file when a clip has the same name", async () => {
    askRendererMock.mockResolvedValue({
      audioBase64: Buffer.from('new-take').toString('base64'),
      mediaType: 'audio/wav',
      voice: 'Ryan',
      engine: 'kokoro',
    })
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-files-'))
    fs.writeFileSync(path.join(filesDir, 'speech.wav'), 'earlier')
    const tool = await buildTool(SYNTHESIZE_SPEC, {
      sessionMedia: { sessionRef: 'session-1', workspace: 'game', filesDir },
    })

    await run(tool, { text: 'one' })

    expect(fs.readFileSync(path.join(filesDir, 'speech.wav'), 'utf8')).toBe('earlier')
    expect(fs.readFileSync(path.join(filesDir, 'speech-1.wav'), 'utf8')).toBe('new-take')
  })

  it('reports empty text and an engine failure as a tool failure', async () => {
    const tool = await buildTool(SYNTHESIZE_SPEC)

    expect(await run(tool, { text: '  ' })).toMatchObject({ ok: false })
    expect(askRendererMock).not.toHaveBeenCalled()

    askRendererMock.mockRejectedValueOnce(new Error('no voice model'))
    expect(await run(tool, { text: 'hello' })).toMatchObject({
      ok: false,
      message: 'no voice model',
    })
  })

  it('transcribes a workspace file, typed from its extension', async () => {
    fs.mkdirSync(path.join(workspaceDir, 'attachments'))
    fs.writeFileSync(path.join(workspaceDir, 'attachments', 'note.m4a'), 'A')
    askRendererMock.mockResolvedValue({ text: 'what was said' })
    const tool = await buildTool(TRANSCRIBE_SPEC)

    const output = await run(tool, { sourceAudioPath: 'attachments/note.m4a' })

    expect(askRendererMock.mock.calls[0][0]).toMatchObject({
      kind: 'speech-transcribe',
      audioBase64: Buffer.from('A').toString('base64'),
      mediaType: 'audio/mp4',
    })
    expect(output).toMatchObject({ ok: true, transcript: 'what was said' })
  })

  it('refuses a missing path, an escaping path and an unsupported type', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'notes.txt'), 'x')
    const tool = await buildTool(TRANSCRIBE_SPEC)

    expect(await run(tool, {})).toMatchObject({ ok: false })
    expect(await run(tool, { sourceAudioPath: '../outside.wav' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('escapes the workspace'),
    })
    expect(await run(tool, { sourceAudioPath: 'notes.txt' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('Unsupported audio file type'),
    })
    expect(askRendererMock).not.toHaveBeenCalled()
  })
})

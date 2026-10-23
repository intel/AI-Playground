import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { AgentToolSpec } from '@/types/agentIpc'

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

async function buildTool(spec: AgentToolSpec): Promise<BuiltTool> {
  const host = {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [spec],
    agentDir: workspaceDir,
    keepModelsLoaded: false,
  }
  const [tool] = (await buildSpeechTools(host, [spec])) as unknown as BuiltTool[]
  return tool
}

function parseOutput(output: unknown): Record<string, unknown> {
  const result = output as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0].text)
}

function run(tool: BuiltTool, params: unknown): Promise<Record<string, unknown>> {
  return tool
    .execute('call-1', params, new AbortController().signal)
    .then((output) => parseOutput(output))
}

describe('mediaSpeech (agent speech tools)', () => {
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-speech-'))
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

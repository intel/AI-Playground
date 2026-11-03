import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'

type Artifact = { entryId: string; path: string; url: string }

const fakes = vi.hoisted(() => ({
  sessions: null as unknown as { openSessionId: string | null; openTimeline: unknown[] },
  sessionSettings: null as unknown as { ready: boolean },
  presets: null as unknown as {
    activePreset: { name: string; type: 'chat' | 'comfy'; sttPreset?: boolean } | null
    activeVariantName: Record<string, string>
  },
  imageGeneration: null as unknown as {
    defaultImageInputMode: 'imageEdit' | 'video' | null
    inputPick: { mode: string; at: number } | null
    fillDefaultReference: (url: string) => boolean
  },
  chat: null as unknown as { fileInput: { type: 'file'; url: string; mediaType: string }[] },
  report: (..._args: unknown[]) => {},
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: fakes.report }) }))
vi.mock('@/assets/js/store/sessions', () => ({ useSessions: () => fakes.sessions }))
vi.mock('@/assets/js/store/sessionSettings', () => ({
  useSessionSettings: () => fakes.sessionSettings,
}))
vi.mock('@/assets/js/store/presets', () => ({ usePresets: () => fakes.presets }))
vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  useImageGenerationPresets: () => fakes.imageGeneration,
}))
vi.mock('@/assets/js/store/openAiCompatibleChat', () => ({
  useOpenAiCompatibleChat: () => fakes.chat,
}))

const { useSessionDefaultInputs } = await import('@/assets/js/store/sessionDefaultInputs')

let newest: Record<'image' | 'audio', Artifact | null>
let fill: ReturnType<typeof vi.fn<(url: string) => boolean>>

function artifact(entryId: string, name: string): Artifact {
  return { entryId, path: `files/${name}`, url: `aipg-media://sessions/s1/files/${name}` }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/** A new History Entry reaches the renderer as a changed display timeline. */
async function arrive(mediaType: 'image' | 'audio', next: Artifact): Promise<void> {
  newest[mediaType] = next
  fakes.sessions.openTimeline = [...fakes.sessions.openTimeline, { id: next.entryId }]
  await settle()
}

const editPreset = { name: 'Edit By Prompt', type: 'comfy' as const }
const imageGenPreset = { name: 'Fast', type: 'comfy' as const }
const sttPreset = { name: 'Speech To Text', type: 'chat' as const, sttPreset: true }

async function activate(
  preset: typeof editPreset | typeof sttPreset,
  mode: 'imageEdit' | 'video' | null,
): Promise<void> {
  fakes.presets.activePreset = preset
  fakes.imageGeneration.defaultImageInputMode = mode
  await settle()
}

beforeEach(() => {
  setActivePinia(createPinia())
  newest = { image: null, audio: null }
  fill = vi.fn<(url: string) => boolean>(() => true)
  fakes.sessions = reactive({ openSessionId: 's1', openTimeline: [] as unknown[] })
  fakes.sessionSettings = reactive({ ready: true })
  fakes.presets = reactive({ activePreset: imageGenPreset, activeVariantName: {} })
  fakes.imageGeneration = reactive({
    defaultImageInputMode: null as 'imageEdit' | 'video' | null,
    inputPick: null as { mode: string; at: number } | null,
    fillDefaultReference: (url: string) => fill(url),
  })
  fakes.chat = reactive({ fileInput: [] as { type: 'file'; url: string; mediaType: string }[] })
  globalThis.window = {
    electronAPI: {
      sessions: {
        newestArtifact: vi.fn(async (_id: string, mediaType: 'image' | 'audio') => ({
          success: true,
          artifact: newest[mediaType],
        })),
      },
    },
  } as unknown as Window & typeof globalThis
})

describe('Session default inputs', () => {
  it('fills an Image Edit preset with the newest image when it becomes active', async () => {
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await settle()
    expect(fill).not.toHaveBeenCalled()

    await activate(editPreset, 'imageEdit')
    expect(fill).toHaveBeenLastCalledWith('aipg-media://sessions/s1/files/fox.png')
  })

  it('fills again after each new matching artifact', async () => {
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await activate(editPreset, 'imageEdit')

    await arrive('image', artifact('e2', 'cover.png'))
    expect(fill).toHaveBeenLastCalledWith('aipg-media://sessions/s1/files/cover.png')
  })

  it('keeps a manual pick until the next matching artifact', async () => {
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await activate(editPreset, 'imageEdit')
    fill.mockClear()

    fakes.imageGeneration.inputPick = { mode: 'imageEdit', at: 1 }
    await settle()
    fakes.sessions.openTimeline = [...fakes.sessions.openTimeline, { id: 'chat-turn' }]
    await settle()
    await activate(sttPreset, null)
    await activate(editPreset, 'imageEdit')
    expect(fill).not.toHaveBeenCalled()

    await arrive('image', artifact('e2', 'cover.png'))
    expect(fill).toHaveBeenLastCalledWith('aipg-media://sessions/s1/files/cover.png')
  })

  it('lets the Edit button choose the input of the preset it switches to', async () => {
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await settle()

    fakes.imageGeneration.inputPick = { mode: 'imageEdit', at: 1 }
    await settle()
    await activate(editPreset, 'imageEdit')
    expect(fill).not.toHaveBeenCalled()
  })

  it('leaves image-generation presets alone', async () => {
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await settle()
    await arrive('image', artifact('e2', 'cover.png'))
    expect(fill).not.toHaveBeenCalled()
    expect(fakes.chat.fileInput).toEqual([])
  })

  it('pre-attaches the newest audio to a Speech-to-Text preset and drops it on leaving', async () => {
    newest.audio = artifact('a1', 'hello.wav')
    newest.image = artifact('e1', 'fox.png')
    useSessionDefaultInputs()
    await activate(sttPreset, null)
    expect(fakes.chat.fileInput).toEqual([
      {
        type: 'file',
        mediaType: 'audio/wav',
        url: 'aipg-media://sessions/s1/files/hello.wav',
        filename: 'hello.wav',
      },
    ])

    await arrive('audio', artifact('a2', 'tts_2.mp3'))
    expect(fakes.chat.fileInput.map((part) => part.url)).toEqual([
      'aipg-media://sessions/s1/files/tts_2.mp3',
    ])

    fakes.presets.activePreset = imageGenPreset
    await settle()
    expect(fakes.chat.fileInput).toEqual([])
  })

  it('treats removing the pre-attached audio as a pick', async () => {
    newest.audio = artifact('a1', 'hello.wav')
    useSessionDefaultInputs()
    await activate(sttPreset, null)

    fakes.chat.fileInput = []
    await settle()
    await activate(editPreset, null)
    await activate(sttPreset, null)
    expect(fakes.chat.fileInput).toEqual([])

    await arrive('audio', artifact('a2', 'tts_2.wav'))
    expect(fakes.chat.fileInput.map((part) => part.url)).toEqual([
      'aipg-media://sessions/s1/files/tts_2.wav',
    ])
  })
})

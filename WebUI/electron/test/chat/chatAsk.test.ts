import { describe, it, expect, vi, beforeEach } from 'vitest'

const sent: Array<{ channel: string; payload: { requestId: string } }> = []
const win = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: { requestId: string }) => sent.push({ channel, payload }),
  },
}
let currentWindow: typeof win | null = win

vi.mock('../../kernel/kernelBus', () => ({
  getKernelEventWindow: () => currentWindow,
}))

const { askRenderer, handleChatAnswer, rejectAllChatAsks, resetChatAskForTest, chatAsksPending } =
  await import('../../chat/chatAsk')

function lastRequestId(): string {
  return sent[sent.length - 1].payload.requestId
}

describe('chatAsk', () => {
  beforeEach(() => {
    sent.length = 0
    currentWindow = win
    resetChatAskForTest()
  })

  it('resolves with the renderer answer and reports phases along the way', async () => {
    const phases: string[] = []
    const answer = askRenderer<{ text: string }>(
      { kind: 'speech-transcribe', audioBase64: 'QQ==' },
      { onPhase: (phase) => phases.push(phase) },
    )
    expect(sent[0].channel).toBe('chat:ask')

    handleChatAnswer({ requestId: lastRequestId(), progress: true, phase: 'generating' })
    handleChatAnswer({ requestId: lastRequestId(), result: { text: 'hello' } })

    await expect(answer).resolves.toEqual({ text: 'hello' })
    expect(phases).toEqual(['generating'])
    expect(chatAsksPending()).toBe(0)
  })

  it('settles a question when the turn it belongs to is cancelled', async () => {
    const controller = new AbortController()
    const answer = askRenderer<boolean>(
      {
        kind: 'home-agent-confirm',
        conversationKey: 'conv-1',
        summaryMarkdown: 'Switch backend',
      },
      { abortSignal: controller.signal },
    )

    controller.abort()

    await expect(answer).rejects.toThrow(/cancelled/i)
    expect(chatAsksPending()).toBe(0)
    // The card the user was looking at may still answer; it must find nobody.
    expect(() => handleChatAnswer({ requestId: lastRequestId(), result: true })).not.toThrow()
  })

  it('refuses before sending when the turn is already cancelled', async () => {
    await expect(
      askRenderer(
        { kind: 'speech-transcribe', audioBase64: 'QQ==' },
        {
          abortSignal: AbortSignal.abort(),
        },
      ),
    ).rejects.toThrow(/cancelled/i)
    expect(sent).toHaveLength(0)
  })

  it('fails the tool rather than hanging when there is no window to ask', async () => {
    currentWindow = null
    await expect(askRenderer({ kind: 'speech-transcribe', audioBase64: 'QQ==' })).rejects.toThrow(
      /No renderer window/,
    )
  })

  it('rejects everything outstanding when the renderer goes away', async () => {
    const first = askRenderer({ kind: 'speech-transcribe', audioBase64: 'QQ==' })
    const second = askRenderer({ kind: 'speech-transcribe', audioBase64: 'Qg==' })

    rejectAllChatAsks('window closed')

    await expect(first).rejects.toThrow('window closed')
    await expect(second).rejects.toThrow('window closed')
    expect(chatAsksPending()).toBe(0)
  })
})

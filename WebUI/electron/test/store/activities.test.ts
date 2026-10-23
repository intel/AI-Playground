import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { useActivities } = await import('@/assets/js/store/activities')

describe('chatActivity', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    globalThis.window = {
      electronAPI: { setLifecycleBusy: () => {} },
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    // @ts-expect-error test teardown of the fake window
    delete globalThis.window
  })

  it('falls back to a global backend load when the chat has no scoped activity', () => {
    const store = useActivities()
    store.begin({
      label: 'Reloading chat model…',
      category: 'backend',
      scope: { kind: 'global' },
    })
    expect(store.chatActivity('conv-1')?.label).toBe('Reloading chat model…')
  })

  it('prefers a chat-scoped activity over the global backend fallback', () => {
    const store = useActivities()
    store.begin({
      label: 'Reloading chat model…',
      category: 'backend',
      scope: { kind: 'global' },
    })
    store.begin({
      label: 'Loading Qwen…',
      category: 'backend',
      scope: { kind: 'chat', conversationKey: 'conv-1' },
    })
    expect(store.chatActivity('conv-1')?.label).toBe('Loading Qwen…')
    expect(store.chatActivity('conv-2')?.label).toBe('Reloading chat model…')
  })
})

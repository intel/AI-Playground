import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ConversationsInvokeName,
  InvokeHandlerMap,
  MainInvokeChannelName,
} from '../../kernel/ipcRegistries'
import type { buildConversationsRegistry } from '../../kernel/registries/conversations'

// Compile-time registry proofs (#301 batch A): vue-tsc enforces every
// assertion here (an expectTypeOf mismatch is a type error), while vitest
// runs the blocks as trivially green. `import type` only — these modules
// pull in 'electron', which does not exist in the vitest node environment.

describe('per-owner handler registries', () => {
  it('extracts exactly the five conversations channels from the manifest', () => {
    expectTypeOf<ConversationsInvokeName>().toEqualTypeOf<
      | 'conversations:bootstrap'
      | 'conversations:migrate'
      | 'conversations:save'
      | 'conversations:delete'
      | 'conversations:saveLastMainKey'
    >()
  })

  it('keeps homeAgent-owned rows out of the main-side names', () => {
    expectTypeOf<
      Extract<MainInvokeChannelName, `channel:${string}` | `homeAgent:${string}`>
    >().toBeNever()
  })

  it('builds a registry keyed by exactly the conversations domain', () => {
    expectTypeOf<
      keyof ReturnType<typeof buildConversationsRegistry>
    >().toEqualTypeOf<ConversationsInvokeName>()
  })

  it('rejects a registry literal that misses a channel (planted omission)', () => {
    const incomplete = {
      'conversations:bootstrap': async () => ({ status: 'error' as const, error: '' }),
      'conversations:migrate': async () => ({ status: 'error' as const, error: '' }),
      'conversations:save': async () => ({ success: false as const, error: '' }),
      'conversations:delete': async () => ({ success: false as const, error: '' }),
      // @ts-expect-error satisfies must reject the missing 'conversations:saveLastMainKey'
    } satisfies InvokeHandlerMap<ConversationsInvokeName>
    expect(Object.keys(incomplete)).not.toContain('conversations:saveLastMainKey')
  })
})

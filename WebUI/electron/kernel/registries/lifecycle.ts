import type { LifecycleSendName, SendHandlerMap } from '../ipcRegistries'

/**
 * The renderer's busy flag lands in main-owned close-policy state; the setter
 * keeps the module-level variable in main.ts.
 */
export type LifecycleDeps = {
  setRendererBusy: (busy: boolean) => void
}

export function buildLifecycleSendRegistry(deps: LifecycleDeps) {
  // The renderer reports whether it has tracked work in flight; an input to
  // the main-owned close policy (see createWindow's 'close' handler).
  return {
    'lifecycle:busy': (_event, busy) => {
      deps.setRendererBusy(busy === true)
    },
  } satisfies SendHandlerMap<LifecycleSendName>
}

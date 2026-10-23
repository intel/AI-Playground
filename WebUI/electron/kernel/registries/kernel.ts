import type { KernelInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import type { getKernelSnapshot } from '../kernelBus'

/** The snapshot seam behind the renderer's listener-first hydration handshake. */
export type KernelDeps = {
  getKernelSnapshot: typeof getKernelSnapshot
}

export function buildKernelRegistry(deps: KernelDeps) {
  // Projection hydration: the renderer subscribes to the kernel event stream
  // BEFORE requesting this snapshot and applies only events above its
  // sequence (docs/architecture-target.md §4.6).
  return {
    'kernel:getSnapshot': () => deps.getKernelSnapshot(),
  } satisfies InvokeHandlerMap<KernelInvokeName>
}

/**
 * The thin remote-turn port (architecture-target §8.2 leftover, step 13).
 *
 * Permissions must not instantiate the Home Agent store: that store is the
 * rest of the renderer graph, and a consent prompt that reaches through it
 * cannot move into main. Home Agent registers `{ isActive, downloadModels }`
 * at store setup; callers that never register get a desktop-only fallback
 * (no remote turn is active).
 */

export type RemoteTurnPort = {
  isActive: () => boolean
  downloadModels: (
    models: DownloadModelParam[],
    options?: { skipConfirmation?: boolean },
  ) => Promise<void>
}

const idlePort: RemoteTurnPort = {
  isActive: () => false,
  downloadModels: async () => {
    throw new Error('No remote turn is active for an in-channel download')
  },
}

let registered: RemoteTurnPort | null = null

export function registerRemoteTurnPort(port: RemoteTurnPort | null): void {
  registered = port
}

export function remoteTurnPort(): RemoteTurnPort {
  return registered ?? idlePort
}

import fs from 'fs'
import { shell } from 'electron'
import type { GamesInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { LocalSettings } from '../../kernel/localSettings'
import type { detectOem } from '../../adapters/hardware/oemDetection'
import type {
  arcadeCatalog,
  createGame,
  listGames,
  provisionalName,
  publishGame,
  readGame,
  setArcadeShown,
  writeArcade,
} from '../../agent/games/gameLibrary'
import type { getGamesDir } from '../../persist/userDataPaths'

/**
 * The game-library operations the nine games handlers close over. `settings`
 * is the live settings object; `oemVendorOverride` is read per call.
 */
export type GamesDeps = {
  settings: LocalSettings
  detectOem: typeof detectOem
  getGamesDir: typeof getGamesDir
  listGames: typeof listGames
  readGame: typeof readGame
  provisionalName: typeof provisionalName
  createGame: typeof createGame
  publishGame: typeof publishGame
  arcadeCatalog: typeof arcadeCatalog
  setArcadeShown: typeof setArcadeShown
  writeArcade: typeof writeArcade
}

export function buildGamesRegistry(deps: GamesDeps) {
  // Game library (see gameLibrary.ts): the folders the Game Agent preset
  // writes into, plus the generated gallery page.
  return {
    'games:list': () => deps.listGames(),

    'games:read': (_event, dir) => deps.readGame(dir),

    // `name` is the request that started the game, not a title: shorten it to
    // something that reads as one, until the agent sets a real one. The request
    // itself is kept whole as provenance.
    'games:create': (_event, name, options) =>
      deps.createGame({
        name: name ? deps.provisionalName(name) : undefined,
        ...(options?.scaffold === false ? { scaffold: false } : {}),
        backend: options?.backend,
        startingModel: options?.startingModel,
        initialPrompt: options?.initialPrompt,
      }),

    'games:publish': async (_event, dir, fields) => {
      try {
        const { vendor } = await deps.detectOem(deps.settings.oemVendorOverride)
        return { success: true as const, game: deps.publishGame(dir, fields ?? {}, { vendor }) }
      } catch (error) {
        return ipcFail(error)
      }
    },

    'games:arcadeCatalog': async () => {
      const { vendor } = await deps.detectOem(deps.settings.oemVendorOverride)
      return deps.arcadeCatalog({ vendor })
    },

    'games:setArcadeShown': async (_event, target) => {
      try {
        const { vendor } = await deps.detectOem(deps.settings.oemVendorOverride)
        deps.setArcadeShown(target, { vendor })
        return { success: true as const }
      } catch (error) {
        return ipcFail(error)
      }
    },

    // A game's own folder, or the library root when none is given.
    'games:openFolder': (_event, dir) => {
      const target = dir ?? deps.getGamesDir()
      fs.mkdirSync(target, { recursive: true })
      shell.openPath(target)
    },

    'games:play': async (_event, dir) => {
      const game = deps.readGame(dir)
      if (!game) return { success: false as const, error: `Not a game folder: ${dir}` }
      if (!fs.existsSync(game.entryPath)) {
        return { success: false as const, error: 'This game has no playable file yet.' }
      }
      // The default browser, not an app window: a game is the user's to keep.
      const error = await shell.openPath(game.entryPath)
      return error ? { success: false as const, error } : { success: true as const }
    },

    // Regenerated on open so the gallery reflects the library as it is now.
    'games:openArcade': async () => {
      const { vendor } = await deps.detectOem(deps.settings.oemVendorOverride)
      const { arcadePath } = deps.writeArcade({ vendor })
      const error = await shell.openPath(arcadePath)
      return error
        ? { success: false as const, error }
        : { success: true as const, path: arcadePath }
    },
  } satisfies InvokeHandlerMap<GamesInvokeName>
}

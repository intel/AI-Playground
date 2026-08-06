import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getMainWindow } from './helpers'
import { AppDriver } from './appDriver'

export const VITE_PORT = 25413
export const VITE_URL = `http://127.0.0.1:${VITE_PORT}`
export const WEBUI_DIR = path.resolve(__dirname, '..')

/**
 * Build and return the compiled Electron main entry. We always rebuild rather
 * than reuse whatever is on disk: a stale `dist/main/main.js` (e.g. built before a
 * dependency was dropped) is silently launched and dies at module load with no
 * window — surfacing only as "No Electron windows appeared". Rebuilding every run
 * keeps main/preload in lockstep with the current sources and deps.
 *
 * `vite build` emits under `../build/dist` (a sibling of WebUI). All package
 * `dependencies` are marked `external` (see vite.config.mts), so the main does a
 * runtime `require('koffi')` etc. — but from `build/dist/main` Node walks up to the
 * repo-root `node_modules`, never into `WebUI/node_modules` where those deps live,
 * so the main dies at load with "Cannot find module". We therefore copy the built
 * output back inside `WebUI/dist` (the same in-WebUI layout `npm run dev` emits) so
 * the external deps resolve from `WebUI/node_modules`.
 */
let builtMainEntry: string | undefined
function resolveMainEntry(): string {
  // Build once per test-run process, not per test: launchElectronApp runs for
  // every spec, but the sources don't change mid-run, so one rebuild at the start
  // is enough to guarantee freshness.
  if (builtMainEntry) return builtMainEntry

  console.log('[e2e] Building Electron main + preload (`vite build --mode development`)...')
  execSync('npx vite build --mode development', {
    cwd: WEBUI_DIR,
    stdio: 'inherit',
    timeout: 300_000,
  })

  // Relocate the compiled main/preload/langchain from ../build/dist into WebUI/dist
  // so runtime `require` of external deps resolves against WebUI/node_modules.
  const buildBase = path.join(WEBUI_DIR, '..', 'build', 'dist')
  const distBase = path.join(WEBUI_DIR, 'dist')
  for (const sub of ['main', 'preload', 'langchain']) {
    const src = path.join(buildBase, sub)
    if (!fs.existsSync(src)) continue
    const dest = path.join(distBase, sub)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(src, dest, { recursive: true })
  }

  const built = path.join(distBase, 'main', 'main.js')
  if (!fs.existsSync(built)) {
    throw new Error(
      `[e2e] Could not find a compiled Electron main entry after build (looked at ${built})`,
    )
  }
  if (!fs.existsSync(path.join(distBase, 'preload', 'preload.js'))) {
    throw new Error(`[e2e] Built main but preload is missing next to ${built}`)
  }
  builtMainEntry = built
  return built
}

/** Best-effort removal of a stale Electron single-instance lock (POSIX only). */
function cleanupSingletonLock(): void {
  if (process.platform === 'win32') return // Windows uses a named mutex freed on exit
  const home = process.env.HOME || ''
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(home, '.config', 'ai-playground', name))
    } catch {
      // not present
    }
  }
}

async function launchOnce(mainPath: string): Promise<ElectronApplication> {
  cleanupSingletonLock()
  const app = await electron.launch({
    // On Linux the dev `node_modules/electron/dist/chrome-sandbox` helper isn't
    // setuid-root (only the packaged build fixes that, via after-pack.cjs), so the
    // SUID sandbox aborts startup *before* JS runs — main.ts's appendSwitch('no-sandbox')
    // is too late. Pass it on argv so it takes effect at process launch.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), mainPath],
    cwd: WEBUI_DIR,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: VITE_URL,
      VITE_DEBUG_TOOLS: 'true',
      VITE_PLATFORM_TITLE: 'from Intel®',
      NODE_ENV: 'development',
      ...(process.platform === 'linux' ? { DISPLAY: process.env.DISPLAY || ':0' } : {}),
    },
    timeout: 60_000,
  })
  // Playwright discards the Electron child's stdout/stderr, so a Chromium abort
  // before `whenReady` (GPU/sandbox/missing-lib crash on Linux) leaves no trace
  // beyond "No Electron windows appeared". Mirror both streams to the test console.
  const child = app.process()
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron:out] ${d}`))
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[electron:err] ${d}`))
  child.on('exit', (code, signal) =>
    console.error(`[electron] main process exited early: code=${code} signal=${signal}`),
  )
  return app
}

export async function launchElectronApp(): Promise<ElectronApplication> {
  const mainPath = resolveMainEntry()

  // Launch, then confirm the renderer window actually appears. A previous test's
  // Electron (or its backend subprocesses) not being fully reaped can make the new
  // instance hit the single-instance guard and quit with no window — especially on
  // Windows, where the guard is a named mutex we can't clear from disk. That surfaces
  // as "No Electron windows appeared within 30s". Rather than fail the test on this
  // harness-level flake, tear the dud down and relaunch once.
  const MAX_ATTEMPTS = 2
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const app = await launchOnce(mainPath)
    try {
      await getMainWindow(app)
      return app
    } catch (error) {
      lastError = error
      await app.close().catch(() => {})
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  throw lastError
}

type E2EFixtures = {
  electronApp: ElectronApplication
  window: Page
  /** High-level driver. `await app.installAllBackends()` is the start of every test. */
  app: AppDriver
}

export const test = base.extend<E2EFixtures>({
  electronApp: async ({}, use) => {
    const app = await launchElectronApp()
    await use(app)
    await app.close()
  },

  window: async ({ electronApp }, use) => {
    const window = await getMainWindow(electronApp)
    window.on('pageerror', (err) => console.error(`[renderer:error] ${err.message}`))
    if (process.env.E2E_VERBOSE) {
      window.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    }

    // The high-memory / video-VRAM warning is an *optional* popup: it fires whenever a
    // gated preset becomes active — including when merely switching to a mode whose
    // last-used preset is gated — so it can appear before any step we control and its
    // backdrop then intercepts clicks. Auto-dismiss it wherever it shows up: tick
    // "Do not show again" (suppresses future prompts for that preset) and Confirm (which
    // proceeds with the switch). Scoped by message so it never touches other warnings.
    const memoryWarning = window
      .getByRole('dialog', { name: 'Warning' })
      .filter({ hasText: /high memory use|discrete GPUs with 16GB/i })
    await window.addLocatorHandler(memoryWarning, async (dialog) => {
      const dontShowAgain = dialog.getByRole('checkbox')
      if (await dontShowAgain.isVisible().catch(() => false)) await dontShowAgain.click()
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    })

    await use(window)
  },

  app: async ({ window }, use) => {
    await use(new AppDriver(window))
  },
})

export { expect } from '@playwright/test'

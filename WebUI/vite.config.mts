import { defineConfig } from 'vite'
import path from 'path'
import type { ChildProcess } from 'node:child_process'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import electron from 'vite-plugin-electron'
import pkg from './package.json' with { type: 'json' }
import tailwindcss from '@tailwindcss/vite'
import { resolveBuildIdentity } from './build/scripts/buildIdentity.mts'

/**
 * Longer than the app's own teardown budget (electron/shutdown.ts), so a normal
 * quit is waited out rather than cut short.
 */
const PREVIOUS_APP_EXIT_TIMEOUT_MS = 20_000

/**
 * Wait for the Electron process from the last reload to actually be gone.
 *
 * vite-plugin-electron signals the running app and spawns the replacement in
 * the same tick, so the two overlap for as long as teardown takes — and the
 * dying app still holds process-wide resources the new one needs at startup:
 * the single-instance lock (the replacement would quit on it) and the
 * remote-debugging port from AIPG_DEBUGGING_PORT, which Chromium binds once and
 * never retries, leaving the reloaded app undebuggable until a manual restart.
 */
function previousAppExit(): Promise<void> {
  const previous = (process as NodeJS.Process & { electronApp?: ChildProcess }).electronApp
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) {
    return Promise.resolve()
  }
  // The plugin exits the dev server when this child exits; drop that listener
  // first so quitting the old app does not take Vite down with it.
  previous.removeAllListeners()
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log('[electron] previous app is still running; starting the new one anyway')
      resolve()
    }, PREVIOUS_APP_EXIT_TIMEOUT_MS)
    previous.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  previous.kill()
  return exited
}

/**
 * Bake the build's commit and release tag in as env vars, which is how the
 * footer gets them (preload reads `import.meta.env`). Vite loads `VITE_*` from
 * `process.env` after this config function has run, and the Electron
 * main/preload builds are children of the same process, so setting them here
 * reaches every bundle.
 */
function exposeBuildIdentity(): void {
  const { commit, tag } = resolveBuildIdentity(pkg.version)
  process.env.VITE_GIT_COMMIT = commit
  process.env.VITE_GIT_TAG = tag
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  exposeBuildIdentity()
  const isServe = command === 'serve'
  const isBuild = command === 'build'
  // `vite --mode test` serves only the Vue renderer (no Electron plugin), so the
  // Playwright e2e run can point a separately-launched Electron main process at
  // this dev server via VITE_DEV_SERVER_URL instead of Vite auto-launching one.
  const isTest = mode === 'test'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG
  const dependenciesToBeTranspiled = ['get-port']
  return {
    build: {
      outDir: isServe ? 'dist' : '../build/dist', // Output Vue.js build to build/dist/renderer
      emptyOutDir: true,
    },
    plugins: [
      tailwindcss(),
      vue({
        template: {
          compilerOptions: {
            // `<model-viewer>` (from @google/model-viewer) is a native custom
            // element, not a Vue component. Without this Vue tries to resolve it
            // as a component and logs "Failed to resolve component: model-viewer".
            isCustomElement: (tag) => tag === 'model-viewer',
          },
        },
      }),
      AutoImport({
        imports: ['vue'],
        dts: 'src/auto-import.d.ts',
      }),
      ...(isTest
        ? []
        : [
            electron([
              {
                // Main-Process entry file of the Electron App.
                entry: 'electron/main.ts',
                onstart(options) {
                  if (process.env.VSCODE_DEBUG) {
                    console.log(/* For `.vscode/.debug.script.mjs` */ '[startup] Electron App')
                  } else {
                    // On Linux, Electron's setuid chrome-sandbox is usually not usable
                    // in dev (cache dir, non-root user), so it fails to start without
                    // `sudo chown root:root chrome-sandbox`. Pass --no-sandbox to skip
                    // it. This mirrors the runtime switch set in electron/main.ts.
                    const argv = process.platform === 'linux' ? ['.', '--no-sandbox'] : undefined
                    void previousAppExit().then(() => options.startup(argv))
                  }
                },
                vite: {
                  build: {
                    sourcemap,
                    minify: isBuild,
                    outDir: isServe ? 'dist/main' : '../build/dist/main',
                    rollupOptions: {
                      external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}).filter(
                        (d) => !dependenciesToBeTranspiled.includes(d),
                      ),
                    },
                  },
                },
              },
              {
                entry: 'electron/preload.ts',
                onstart(options) {
                  // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete,
                  // instead of restarting the entire Electron App.
                  options.reload()
                },
                vite: {
                  build: {
                    sourcemap: sourcemap ? 'inline' : undefined, // #332
                    minify: isBuild,
                    outDir: isServe ? 'dist/preload' : '../build/dist/preload',
                    rollupOptions: {
                      external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
                    },
                  },
                },
              },
              {
                entry: 'electron/subprocesses/langchain.ts',
                vite: {
                  build: {
                    sourcemap: sourcemap ? 'inline' : undefined,
                    minify: isBuild,
                    outDir: isServe ? 'dist/langchain' : '../build/dist/langchain',
                    rollupOptions: {
                      external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
                    },
                  },
                },
              },
            ]),
          ]),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 25413,
      hmr: true,
      proxy: {
        '^/api/': {
          changeOrigin: true,
          target: 'http://127.0.0.1:9999',
        },
      },
      watch: {
        usePolling: true,
        interval: 300,
        // The app writes its model directories back to `external/model_config*.json`
        // (Model folders dialog). That file lives inside the Vite root, so saving a
        // folder would otherwise trigger a full page reload and throw the user out
        // of the view they are editing. Nothing in the renderer imports it — the
        // main process reads it with fs — so ignoring it costs no reactivity.
        ignored: ['**/external/model_config*.json'],
      },
    },
  }
})

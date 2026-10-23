import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as JustBash from 'just-bash'

// ── Loading the agent's ESM dependencies from the CommonJS main bundle ───────
//
// Both packages must be imported, not required:
//
//  - Pi is ESM-only and its package exports declare no `require` condition, so
//    `require()` cannot resolve it at all (the app died at load with
//    ERR_PACKAGE_PATH_NOT_EXPORTED).
//  - just-bash does ship a CJS build, but its bundled python/JavaScript
//    interpreters locate their runtime assets relative to `import.meta.url`,
//    which the CJS build has no value for — every `python3`/`node` call in the
//    sandbox failed with "Invalid URL".
//
// A dynamic `import()` fixes both: Rollup keeps it verbatim for externalized
// packages in CJS output, so Node resolves the ESM entry point relative to the
// bundle's own directory (unlike a `new Function('import(...)')` trick, which
// would resolve against the process cwd).
//
// Everything that needs a value from these packages therefore goes through the
// loaders below. Types are imported statically above and erased at build time.

export type PiModule = typeof Pi
export type JustBashModule = typeof JustBash

let pendingPi: Promise<PiModule> | null = null
let pendingJustBash: Promise<JustBashModule> | null = null

/** The Pi module, imported once per process. */
export function loadPi(): Promise<PiModule> {
  pendingPi ??= import('@earendil-works/pi-coding-agent')
  return pendingPi
}

/** The just-bash module (ESM build), imported once per process. */
export function loadJustBash(): Promise<JustBashModule> {
  pendingJustBash ??= import('just-bash')
  return pendingJustBash
}

#!/usr/bin/env node
/**
 * ensure-native-modules.mjs
 *
 * Native Node addons must be built for Electron's ABI, not the ABI of the Node
 * that ran `npm install` — otherwise `require()` fails at runtime with "Could
 * not locate the bindings file" or "was compiled against a different Node.js
 * version". `electron-builder` does this for packaged builds (`npmRebuild`), but
 * `npm run dev` runs against node_modules as installed, so the dev app needs the
 * same treatment.
 *
 * For each dependency below: download the prebuilt binary that matches the
 * installed Electron version (seconds, no compiler) and stamp which Electron it
 * was built for, so a later Electron bump re-fetches it.
 *
 * Failure is never fatal: the addons here back optional capabilities, which
 * report themselves as unavailable when their binary is missing. A dev without
 * network access still gets a working app, minus those.
 *
 * Safe to run repeatedly. Runs from `predev` and `setup`.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Native dependencies and the addon each one is expected to produce. */
const NATIVE_MODULES = [
  // SQLite store behind the persistent-memory capability (pi-hermes-memory).
  { name: 'better-sqlite3', binary: path.join('build', 'Release', 'better_sqlite3.node') },
]

const require = createRequire(import.meta.url)
const webuiDir = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const modulesDir = path.join(webuiDir, 'node_modules')

function log(message) {
  console.log(`[ensure-native-modules] ${message}`)
}

const electronPkg = path.join(modulesDir, 'electron', 'package.json')
if (!existsSync(electronPkg)) {
  log('node_modules/electron not installed yet — run `npm install` first. Skipping.')
  process.exit(0)
}
const electronVersion = JSON.parse(readFileSync(electronPkg, 'utf8')).version

for (const { name, binary } of NATIVE_MODULES) {
  const moduleDir = path.join(modulesDir, name)
  if (!existsSync(moduleDir)) {
    log(`${name} is not installed — skipping.`)
    continue
  }

  const binaryPath = path.join(moduleDir, binary)
  // Which Electron the present binary was built for. Without the stamp the
  // binary is assumed foreign (npm's own build, or a previous Electron).
  const stampPath = path.join(moduleDir, 'build', '.electron-abi')
  const stamped = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : ''
  if (existsSync(binaryPath) && stamped === electronVersion) continue

  let prebuildInstall
  try {
    prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [moduleDir] })
  } catch {
    log(`${name}: prebuild-install is unavailable, cannot fetch a binary for Electron.`)
    continue
  }

  log(`Fetching ${name} prebuilt for Electron ${electronVersion} …`)
  const result = spawnSync(
    process.execPath,
    [prebuildInstall, '--runtime', 'electron', '--target', electronVersion],
    { cwd: moduleDir, stdio: 'inherit' },
  )
  if (result.status !== 0 || !existsSync(binaryPath)) {
    log(`${name}: no prebuilt binary for Electron ${electronVersion}.`)
    log(`Capabilities needing ${name} will report themselves as unavailable.`)
    continue
  }
  writeFileSync(stampPath, `${electronVersion}\n`)
  log(`${name} ready for Electron ${electronVersion}.`)
}

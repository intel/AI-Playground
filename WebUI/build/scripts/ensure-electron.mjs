#!/usr/bin/env node
/**
 * ensure-electron.mjs
 *
 * Make `require('electron')` resolvable even when Electron's postinstall could
 * not download the prebuilt binary (common behind corporate proxies, because
 * `@electron/get` / `got` do not reliably honour HTTPS_PROXY).
 *
 * Strategy:
 *   1. If node_modules/electron/{path.txt,dist} already exist -> nothing to do.
 *   2. Ensure a VALID platform zip is present in the Electron cache:
 *        - reuse an already-present, valid cached zip, OR
 *        - download it with `curl` (which DOES honour HTTPS_PROXY), OR
 *        - honour ELECTRON_MIRROR if set.
 *   3. Provision the binary WITHOUT relying on @electron/get's checksum cache:
 *        - extract the zip straight into node_modules/electron/dist/
 *        - write node_modules/electron/path.txt (the file install.js writes).
 *      We do this ourselves because @electron/get silently re-downloads (and
 *      fails behind a proxy) when the cached zip doesn't match its expected
 *      SHASUMS256 cache entry — leaving path.txt missing (the bug you hit).
 *
 * Safe to run repeatedly and on any platform. On Windows it is a no-op when the
 * binary is already present (the normal case).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  chmodSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const webuiDir = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const electronPkgDir = path.join(webuiDir, 'node_modules', 'electron')
const distDir = path.join(electronPkgDir, 'dist')
const pathTxt = path.join(electronPkgDir, 'path.txt')

function log(msg) {
  console.log(`[ensure-electron] ${msg}`)
}

if (!existsSync(electronPkgDir)) {
  log('node_modules/electron not installed yet — run `npm install` first. Skipping.')
  process.exit(0)
}

if (existsSync(pathTxt) && existsSync(distDir)) {
  // Binary already provisioned. Nothing to do.
  process.exit(0)
}

// Resolve the exact Electron version that npm installed.
const version = require(path.join(electronPkgDir, 'package.json')).version

// Electron asset naming uses Node's platform/arch values directly.
const ePlatform = process.platform // win32 | darwin | linux
const eArch = process.arch // x64 | arm64 | ia32
const assetName = `electron-v${version}-${ePlatform}-${eArch}.zip`

// The executable name inside dist/ and the value written to path.txt.
const exeName =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron'

// Electron's default cache location used by @electron/get.
const cacheRoot =
  process.env.electron_config_cache ||
  path.join(
    os.homedir(),
    process.platform === 'win32' ? 'AppData/Local/electron/Cache' : '.cache/electron',
  )
const cacheZip = path.join(cacheRoot, assetName)

const mirror =
  process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/'
const downloadUrl = `${mirror.replace(/\/?$/, '/')}v${version}/${assetName}`

function commandAvailable(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
}

/** A real zip starts with the local-file-header magic "PK\x03\x04". */
function looksLikeZip(file) {
  try {
    if (!existsSync(file) || statSync(file).size < 1024) return false
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(4)
    readSync(fd, buf, 0, 4, 0)
    closeSync(fd)
    return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)
  } catch {
    return false
  }
}

// ── 1. ensure a valid cached zip ────────────────────────────────────────────
if (existsSync(cacheZip) && !looksLikeZip(cacheZip)) {
  log('Cached Electron zip is invalid/partial — removing it.')
  rmSync(cacheZip, { force: true })
}

if (!existsSync(cacheZip)) {
  if (!commandAvailable('curl')) {
    log('Electron binary missing and curl unavailable — letting Electron postinstall handle it.')
    process.exit(0)
  }
  mkdirSync(cacheRoot, { recursive: true })
  log(`Downloading Electron ${version} via curl (honours HTTPS_PROXY):`)
  log(`  ${downloadUrl}`)
  const res = spawnSync(
    'curl',
    ['-fL', '--retry', '3', '--connect-timeout', '30', downloadUrl, '-o', cacheZip],
    { stdio: 'inherit' },
  )
  if (res.status !== 0 || !looksLikeZip(cacheZip)) {
    log('curl download failed or produced a non-zip — check proxy / ELECTRON_MIRROR.')
    rmSync(cacheZip, { force: true })
    process.exit(1)
  }
}

// ── 2. extract straight into dist/ (bypass @electron/get checksum cache) ─────
log(`Extracting ${path.basename(cacheZip)} into node_modules/electron/dist …`)
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

let extracted = false

// Primary: the bundled 7-Zip binary fetched by `npm run fetch-external-resources`.
// It lives at <repo-root>/build/resources/7zr.exe on every platform (on Linux it
// is the `7zz` ELF renamed to 7zr.exe). 7-Zip extracts zip archives natively and
// preserves unix file modes — no system package required.
const sevenZip = path.join(webuiDir, '..', 'build', 'resources', '7zr.exe')
if (existsSync(sevenZip)) {
  if (process.platform !== 'win32') {
    try {
      chmodSync(sevenZip, 0o755)
    } catch {
      /* best effort */
    }
  }
  log(`Extracting with bundled 7-Zip (${sevenZip}) …`)
  const r = spawnSync(sevenZip, ['x', '-y', `-o${distDir}`, cacheZip], {
    stdio: 'inherit',
    timeout: 120000,
  })
  extracted = r.status === 0
  if (!extracted) log('7-Zip extraction failed; trying system unzip/tar …')
} else {
  log(`Bundled 7-Zip not found at ${sevenZip} (run \`npm run fetch-external-resources\`).`)
}

if (!extracted && commandAvailable('unzip')) {
  extracted =
    spawnSync('unzip', ['-oq', cacheZip, '-d', distDir], { stdio: 'inherit' }).status === 0
}
if (!extracted) {
  // Fallback: bsdtar / modern tar can read zip archives (GNU tar cannot).
  extracted = spawnSync('tar', ['-xf', cacheZip, '-C', distDir], { stdio: 'inherit' }).status === 0
}
if (!extracted) {
  log('Failed to extract the Electron zip. Run `npm run fetch-external-resources` to get 7-Zip,')
  log('or install unzip with: sudo apt install -y unzip')
  process.exit(1)
}

// ── 3. finalize: flatten if nested, chmod, write path.txt ────────────────────
let exePath = path.join(distDir, exeName)
if (!existsSync(exePath)) {
  // Some archives nest everything under a single top-level folder; flatten it.
  const entries = readdirSync(distDir)
  if (entries.length === 1 && statSync(path.join(distDir, entries[0])).isDirectory()) {
    const inner = path.join(distDir, entries[0])
    if (existsSync(path.join(inner, exeName))) {
      for (const e of readdirSync(inner)) {
        spawnSync('mv', [path.join(inner, e), path.join(distDir, e)], { stdio: 'ignore' })
      }
      rmSync(inner, { recursive: true, force: true })
    }
  }
  exePath = path.join(distDir, exeName)
}

if (!existsSync(exePath)) {
  log(`Extraction finished but ${exeName} was not found in dist/. Contents:`)
  log('  ' + readdirSync(distDir).join(', '))
  process.exit(1)
}

if (process.platform !== 'win32') {
  try {
    chmodSync(exePath, 0o755)
  } catch {
    /* best effort */
  }
}

writeFileSync(pathTxt, exeName)
log(`Electron binary provisioned successfully (path.txt -> ${exeName}).`)

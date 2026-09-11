#!/usr/bin/env node
/**
 * Runs electron-builder with `INSTALLER_ID` set, which `artifactName` expands
 * into the installer filename (see build-config.json).
 *
 * It is a script rather than an npm-script prefix because electron-builder
 * *throws* on an unset `${env.…}` macro, and there is no portable way to compute
 * the value inline for both cmd.exe and sh.
 */

import { spawnSync } from 'node:child_process'
import { resolveBuildIdentity } from './buildIdentity.mts'

const identity = resolveBuildIdentity()
console.log(
  `📦 installer id: ${identity.installerId}` +
    ` (commit ${identity.commit || 'unknown'}${identity.tag ? `, tag ${identity.tag}` : ''})`,
)

const result = spawnSync('electron-builder', process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, INSTALLER_ID: identity.installerId },
})

if (result.error) {
  console.error('❌ Failed to run electron-builder:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)

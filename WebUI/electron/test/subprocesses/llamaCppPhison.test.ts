import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import * as filesystem from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { binary } from '../../subprocesses/tools'
import {
  computePhisonArtifactsReady,
  computeStandardArtifactsReady,
  ensureSsdOffloadConfigFileSync,
  getLlamaCppDirForVariant,
  getModelServerEnvAdditions,
  getRelativeSsdOffloadConfigPath,
  getSsdOffloadConfigPath,
  getZipPathForVariant,
  migrateLegacyPhisonIntoSeparateDirectory,
  migrateLegacySsdOffloadConfigFile,
  normalizeOffloadDrivePath,
} from '../../subprocesses/llamaCppPhison'

const tempDirs: string[] = []

function createServiceDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'llamacpp-phison-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

describe('llamaCppPhison helpers', () => {
  it('keeps standard and Phison artifacts isolated on disk', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')

    expect(standardDir).toBe(path.join(serviceDir, 'llama-cpp'))
    expect(phisonDir).toBe(path.join(serviceDir, 'llama-cpp-phison'))
    expect(getZipPathForVariant(serviceDir, 'standard', 'zip')).toBe(
      path.join(serviceDir, 'llama-cpp.zip'),
    )
    expect(getZipPathForVariant(serviceDir, 'ssd-offload', 'zip')).toBe(
      path.join(serviceDir, 'llama-cpp-phison.zip'),
    )
  })

  it('detects standard vs Phison artifact readiness independently', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')

    filesystem.ensureDirSync(standardDir)
    filesystem.ensureDirSync(phisonDir)
    filesystem.writeFileSync(path.join(standardDir, binary('llama-server')), '')
    filesystem.writeFileSync(path.join(phisonDir, binary('llama-server')), '')

    expect(computeStandardArtifactsReady(serviceDir)).toBe(true)
    expect(computePhisonArtifactsReady(serviceDir)).toBe(false)

    filesystem.writeFileSync(path.join(phisonDir, 'ada.exe'), '')
    expect(computePhisonArtifactsReady(serviceDir)).toBe(true)

    filesystem.writeFileSync(path.join(standardDir, 'ada.exe'), '')
    expect(computeStandardArtifactsReady(serviceDir)).toBe(false)
  })

  it('migrates legacy Phison installs and config files without touching standard defaults', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const legacyConfigPath = path.join(serviceDir, 'aidaptiv(303G0B).json')

    filesystem.ensureDirSync(standardDir)
    filesystem.writeFileSync(path.join(standardDir, 'ada.exe'), '')
    filesystem.writeFileSync(path.join(standardDir, 'custom.txt'), 'legacy-phison')
    filesystem.ensureDirSync(serviceDir)
    filesystem.writeJsonSync(legacyConfigPath, { legacy: true })

    migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
    migrateLegacyPhisonIntoSeparateDirectory(serviceDir)

    expect(filesystem.existsSync(configPath)).toBe(true)
    expect(filesystem.readJsonSync(configPath)).toEqual({ legacy: true })
    expect(filesystem.existsSync(path.join(phisonDir, 'custom.txt'))).toBe(true)
    expect(filesystem.existsSync(standardDir)).toBe(true)
  })

  it('normalizes SSD settings and exposes relative config paths', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)

    expect(normalizeOffloadDrivePath('r:')).toBe('R:\\')
    expect(normalizeOffloadDrivePath(' /mnt/fast ')).toBe('/mnt/fast')
    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', configPath)).toBe(
      path.join('..', 'aidaptiv_config.json'),
    )
    expect(getModelServerEnvAdditions('standard')).toEqual({})
    expect(getModelServerEnvAdditions('ssd-offload')).toEqual({ GGML_VK_DISABLE_F16: '1' })
  })
})

import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import * as filesystem from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { binary } from '../../subprocesses/tools'
import {
  computePhisonArtifactsReady,
  computeStandardArtifactsReady,
  defaultAidaptivPath,
  PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB,
  PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB,
  ensureSsdOffloadConfigFileSync,
  ensureSsdOffloadEmbeddingConfigFileSync,
  getLlamaCppDirForVariant,
  getModelServerEnvAdditions,
  getRelativeSsdOffloadConfigPath,
  getSsdOffloadConfigPath,
  getSsdOffloadEmbeddingConfigPath,
  getZipPathForVariant,
  migrateLegacyPhisonIntoSeparateDirectory,
  migrateLegacySsdOffloadConfigFile,
  reconcileSsdOffloadConfig,
  withConfigFileArg,
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

  it('exposes relative config paths', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)

    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', configPath)).toBe(
      path.join('..', 'aidaptiv_config.json'),
    )
    expect(getModelServerEnvAdditions('standard')).toEqual({})
    expect(getModelServerEnvAdditions('ssd-offload')).toEqual({ GGML_VK_DISABLE_F16: '1' })
  })

  it('gives the embedding server its own config with no aiDAPTIV budgets of its own', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    expect(embeddingConfigPath).not.toBe(configPath)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    const llm = filesystem.readJsonSync(configPath)
    const embedding = filesystem.readJsonSync(embeddingConfigPath)

    // The embedding config carries only the aiDAPTIV block: no `common` of its
    // own (the llama.cpp side comes from the shared startup parameters on the
    // argv), and none of the aiDAPTIV budget keys at all — an embedding pass has
    // no KV cache worth parking on the SSD and no experts worth pinning in VRAM,
    // and leaving the keys out entirely (rather than writing zeros) is what keeps
    // the LLM server's own reservations untouched.
    expect(embedding.common).toBeUndefined()
    expect(llm.common.gpu_layers).toBe('999')
    expect(embedding.aidaptiv.cache_kv_offload_gb).toBeUndefined()
    expect(embedding.aidaptiv.dram_kv_offload_gb).toBeUndefined()
    expect(embedding.aidaptiv.vram_experts_cached_gb).toBeUndefined()
    expect(embedding.aidaptiv.kv_cache_resume_policy).toBeUndefined()
    // `-1` is the middleware's automatic budget. A fixed cap fails large-MoE
    // loads, and `fit: off` must not be seeded either.
    expect(llm.common.fit).toBeUndefined()
    expect(llm.aidaptiv.cache_kv_offload_gb).toBe(PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB)
    expect(llm.aidaptiv.vram_experts_cached_gb).toBe(PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB)
    expect(PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB).toBe(-1)
    expect(PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB).toBe(-1)

    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', embeddingConfigPath)).toBe(
      path.join('..', 'aidaptiv_embedding_config.json'),
    )
  })

  it('does not overwrite an existing embedding config', () => {
    const serviceDir = createServiceDir()
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    filesystem.ensureDirSync(serviceDir)
    filesystem.writeJsonSync(embeddingConfigPath, { aidaptiv: { cache_kv_offload_gb: 4 } })
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    expect(filesystem.readJsonSync(embeddingConfigPath)).toEqual({
      aidaptiv: { cache_kv_offload_gb: 4 },
    })
  })

  // No `offload_path` in either config: the middleware locates the aiDAPTIV
  // device itself on a machine provisioned without a drive letter, so any value
  // seeded here could only name something that is not the SSD. `debug_log_path`
  // is still ours to pick, and has to exist.
  it('seeds both configs with a usable debug log path and no offload path', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    for (const seeded of [configPath, embeddingConfigPath]) {
      const { offload_path, debug_log_path } = filesystem.readJsonSync(seeded).aidaptiv
      expect(offload_path).toBeUndefined()
      expect(debug_log_path).toBe(defaultAidaptivPath(serviceDir))
      expect(filesystem.existsSync(debug_log_path)).toBe(true)
    }
  })

  describe('reconcileSsdOffloadConfig', () => {
    it('renames the legacy offload key and keeps unknown keys', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        common: { gpu_layers: '999' },
        aidaptiv: { ssd_kv_offload_gb: 10, offload_path: serviceDir, debug_log_path: serviceDir },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      const config = filesystem.readJsonSync(configPath)
      expect(config.aidaptiv.cache_kv_offload_gb).toBe(-1)
      expect(config.aidaptiv.ssd_kv_offload_gb).toBeUndefined()
      // Keys the app does not know about, and the whole `common` block, survive
      // the rewrite.
      expect(config.aidaptiv.debug_log_path).toBe(serviceDir)
      expect(config.common.gpu_layers).toBe('999')
    })

    it('repairs a debug log path pointing at a drive this machine does not have', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, { aidaptiv: { debug_log_path: 'Q:\\nope' } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.debug_log_path).toBe(
        defaultAidaptivPath(serviceDir),
      )
    })

    // Every config an older build seeded names a drive letter. The middleware
    // now finds the aiDAPTIV device itself, and on a machine set up without a
    // letter the one on disk is stale — it fails the load with MDW-EPC-5003,
    // whether or not the path happens to resolve to some other disk.
    it('drops an offload path left behind by an older build', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)
      const reachablePath = path.join(serviceDir, 'fast-ssd')

      filesystem.ensureDirSync(reachablePath)
      for (const stale of ['Q:\\nope', reachablePath]) {
        filesystem.writeJsonSync(configPath, {
          aidaptiv: { offload_path: stale, debug_log_path: serviceDir },
        })

        await reconcileSsdOffloadConfig(configPath, serviceDir)

        const aidaptiv = filesystem.readJsonSync(configPath).aidaptiv
        expect('offload_path' in aidaptiv).toBe(false)
        expect(aidaptiv.debug_log_path).toBe(serviceDir)
      }
    })

    // `-1` is the budget the current middleware wants. It must survive a launch,
    // and the fixed caps older builds wrote (including 0) have to be replaced
    // or the next start loads the model with the cap that fails it.
    it('keeps budgets of -1', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        aidaptiv: {
          debug_log_path: serviceDir,
          cache_kv_offload_gb: -1,
          vram_experts_cached_gb: -1,
        },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      const aidaptiv = filesystem.readJsonSync(configPath).aidaptiv
      expect(aidaptiv.cache_kv_offload_gb).toBe(-1)
      expect(aidaptiv.vram_experts_cached_gb).toBe(-1)
    })

    it('rewrites fixed offload budgets to -1 and drops fit: off', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        common: { gpu_layers: '999', fit: 'off' },
        aidaptiv: {
          debug_log_path: serviceDir,
          cache_kv_offload_gb: 0,
          vram_experts_cached_gb: 10,
        },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      const config = filesystem.readJsonSync(configPath)
      expect(config.common.fit).toBeUndefined()
      expect(config.common.gpu_layers).toBe('999')
      expect(config.aidaptiv.cache_kv_offload_gb).toBe(-1)
      expect(config.aidaptiv.vram_experts_cached_gb).toBe(-1)
    })

    it('does not add offload budgets to the embedding config', async () => {
      const serviceDir = createServiceDir()
      const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

      ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)
      await reconcileSsdOffloadConfig(embeddingConfigPath, serviceDir)

      const embedding = filesystem.readJsonSync(embeddingConfigPath)
      expect(embedding.common).toBeUndefined()
      expect(embedding.aidaptiv.cache_kv_offload_gb).toBeUndefined()
      expect(embedding.aidaptiv.vram_experts_cached_gb).toBeUndefined()
    })

    it('leaves a debug log path that does exist alone', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)
      const userPath = path.join(serviceDir, 'logs')

      filesystem.ensureDirSync(userPath)
      filesystem.writeJsonSync(configPath, { aidaptiv: { debug_log_path: userPath } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.debug_log_path).toBe(userPath)
    })

    it('is a no-op on a config it has nothing to repair', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      ensureSsdOffloadConfigFileSync(serviceDir, configPath)
      const before = filesystem.readJsonSync(configPath)

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath)).toEqual(before)
    })
  })

  describe('withConfigFileArg', () => {
    const target = '..\aidativ_embedding_config.json'

    it('replaces the value of a spaced --config-file, keeping other flags', () => {
      expect(
        withConfigFileArg(
          ['--gpu-layers', '999', '--config-file', '..\aidaptiv_config.json'],
          target,
        ),
      ).toEqual(['--gpu-layers', '999', '--config-file', target])
    })

    it('replaces the --config-file=value spelling', () => {
      expect(
        withConfigFileArg(['--config-file=../aidaptiv_config.json', '-fa', 'on'], target),
      ).toEqual([`--config-file=${target}`, '-fa', 'on'])
    })

    it('appends the flag when the user removed it', () => {
      expect(withConfigFileArg(['--gpu-layers', '999'], target)).toEqual([
        '--gpu-layers',
        '999',
        '--config-file',
        target,
      ])
    })

    it('collapses a repeated --config-file to a single occurrence', () => {
      expect(
        withConfigFileArg(
          ['--config-file', 'a.json', '--jinja', '--config-file', 'b.json'],
          target,
        ),
      ).toEqual(['--config-file', target, '--jinja'])
    })

    it('does not swallow the next flag after a bare --config-file', () => {
      expect(withConfigFileArg(['--config-file', '--jinja'], target)).toEqual([
        '--config-file',
        target,
        '--jinja',
      ])
    })
  })
})

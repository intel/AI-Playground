import path from 'node:path'
import * as filesystem from 'fs-extra'
import { binary } from './tools.ts'

export type LlamaCppBuildVariant = 'standard' | 'ssd-offload'

type PhisonLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export const LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE =
  'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/aiDAPTIV_vNXWVB_3_05.0.zip'
export const LLAMACPP_SSD_OFFLOAD_CONFIG_NAME = 'aidaptiv_config.json'
export const LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME = 'aidaptiv(303G0B).json'
export const LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT = 'wService_delete.bat'
export const LLAMACPP_SSD_OFFLOAD_CREATE_SERVICE_SCRIPT = 'wService_create.bat'
export const LLAMACPP_SSD_OFFLOAD_PROCESS_NAME = 'ada.exe'

const LLAMA_CPP_SUBDIR_STANDARD = 'llama-cpp'
const LLAMA_CPP_SUBDIR_PHISON = 'llama-cpp-phison'

const LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG = {
  common: {
    seed: '0',
    flash_attn: 'on',
    swa_full: true,
    threads: 10,
    mmap: false,
    fit: 'off',
    context_shift: false,
    verbose: true,
    split_mode: 'none',
    parallel: 1,
    gpu_layers: '999',
  },
  aidaptiv: {
    offload_path: 'R:\\',
    debug_log_path: 'R:\\',
    dram_kv_offload_gb: 0,
    cache_kv_offload_gb: 10,
    kv_cache_resume_policy: true,
    vram_experts_cached_gb: 10,
  },
}

export function isSsdOffloadVariant(variant: LlamaCppBuildVariant): boolean {
  return variant === 'ssd-offload'
}

export function getLlamaCppDirForVariant(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): string {
  const subdir = isSsdOffloadVariant(variant) ? LLAMA_CPP_SUBDIR_PHISON : LLAMA_CPP_SUBDIR_STANDARD
  return path.resolve(path.join(serviceDir, subdir))
}

export function getActiveLlamaCppExePath(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): string {
  return path.resolve(
    path.join(getLlamaCppDirForVariant(serviceDir, variant), binary('llama-server')),
  )
}

export function getZipPathForVariant(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
  platformExtension: string,
): string {
  const suffix = isSsdOffloadVariant(variant) ? '-phison' : ''
  return path.resolve(path.join(serviceDir, `llama-cpp${suffix}.${platformExtension}`))
}

export function getSsdOffloadConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_CONFIG_NAME))
}

export function getLegacySsdOffloadConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME))
}

export function getRelativeSsdOffloadConfigPath(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
  configPath: string,
): string {
  const relativePath = path.relative(getLlamaCppDirForVariant(serviceDir, variant), configPath)
  return relativePath || path.basename(configPath)
}

export function computeStandardArtifactsReady(serviceDir: string): boolean {
  const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
  const exe = path.join(standardDir, binary('llama-server'))
  if (!filesystem.existsSync(exe)) return false
  return !filesystem.existsSync(path.join(standardDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME))
}

export function computePhisonArtifactsReady(serviceDir: string): boolean {
  const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
  const exe = path.join(phisonDir, binary('llama-server'))
  if (!filesystem.existsSync(exe)) return false
  return filesystem.existsSync(path.join(phisonDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME))
}

export function computeVariantArtifactsReady(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): boolean {
  return isSsdOffloadVariant(variant)
    ? computePhisonArtifactsReady(serviceDir)
    : computeStandardArtifactsReady(serviceDir)
}

export function normalizeOffloadDrivePath(offloadDrive?: string | null): string | null {
  if (!offloadDrive) {
    return null
  }

  const trimmed = offloadDrive.trim()
  const driveMatch = trimmed.match(/^([A-Za-z]):/)
  if (!driveMatch) {
    return trimmed
  }

  return `${driveMatch[1].toUpperCase()}:\\`
}

export function migrateLegacySsdOffloadConfigFile(serviceDir: string, configPath: string): void {
  const legacyConfigPath = getLegacySsdOffloadConfigPath(serviceDir)
  if (filesystem.existsSync(legacyConfigPath) && !filesystem.existsSync(configPath)) {
    filesystem.moveSync(legacyConfigPath, configPath)
  }
}

export function ensureSsdOffloadConfigFileSync(serviceDir: string, configPath: string): void {
  migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
  if (filesystem.existsSync(configPath)) {
    return
  }

  filesystem.ensureDirSync(serviceDir)
  filesystem.writeJsonSync(configPath, LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG, { spaces: 2 })
}

export async function ensureSsdOffloadConfigFile(
  serviceDir: string,
  configPath: string,
): Promise<void> {
  migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
  if (await filesystem.pathExists(configPath)) {
    return
  }

  await filesystem.ensureDir(serviceDir)
  await filesystem.writeJson(configPath, LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG, { spaces: 2 })
}

export async function updateSsdOffloadConfig(
  configPath: string,
  offloadDrive: string | null,
  logger?: PhisonLogger,
): Promise<void> {
  if (!filesystem.existsSync(configPath) || !offloadDrive) {
    return
  }

  try {
    const config = await filesystem.readJson(configPath)
    const aidaptiv = { ...(config.aidaptiv ?? {}) }

    // Migrate the legacy `ssd_kv_offload_gb` key to `cache_kv_offload_gb`
    // (the `--ssd-kv-offload-gb` flag was renamed to `--cache-kv-offload-gb`).
    if ('ssd_kv_offload_gb' in aidaptiv) {
      if (!('cache_kv_offload_gb' in aidaptiv)) {
        aidaptiv.cache_kv_offload_gb = aidaptiv.ssd_kv_offload_gb
      }
      delete aidaptiv.ssd_kv_offload_gb
    }

    const updatedConfig = {
      ...config,
      aidaptiv: {
        ...aidaptiv,
        offload_path: offloadDrive,
        debug_log_path: offloadDrive,
      },
    }
    await filesystem.writeJson(configPath, updatedConfig, { spaces: 2 })
    logger?.info?.(`Updated SSD offload config paths to ${offloadDrive}`)
  } catch (error) {
    logger?.warn?.(`Failed to update SSD offload config: ${error}`)
  }
}

export function migrateLegacyPhisonIntoSeparateDirectory(
  serviceDir: string,
  logger?: PhisonLogger,
): void {
  const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
  const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
  if (filesystem.existsSync(phisonDir)) return

  const adaPath = path.join(standardDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME)
  if (!filesystem.existsSync(adaPath)) return

  try {
    filesystem.moveSync(standardDir, phisonDir)
    filesystem.mkdirSync(standardDir, { recursive: true })
    logger?.info?.(
      `Migrated Phison Llama.cpp from ${LLAMA_CPP_SUBDIR_STANDARD}/ to ${LLAMA_CPP_SUBDIR_PHISON}/`,
    )
  } catch (error) {
    logger?.warn?.(`Phison directory migration skipped: ${error}`)
  }
}

export function resolveLlamaCppDownloadUrl(
  version: string,
  variant: LlamaCppBuildVariant,
  platformExtension: string,
  platformArch: string,
): string {
  if (isSsdOffloadVariant(variant)) {
    return LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE.replace('{version}', version)
      .replace('{platformArch}', platformArch)
      .replace('{extension}', platformExtension)
  }

  return `https://github.com/ggml-org/llama.cpp/releases/download/${version}/llama-${version}-bin-${platformArch}.${platformExtension}`
}

export function getModelServerEnvAdditions(
  variant: LlamaCppBuildVariant,
): Partial<NodeJS.ProcessEnv> {
  return isSsdOffloadVariant(variant) ? { GGML_VK_DISABLE_F16: '1' } : {}
}

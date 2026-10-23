import path from 'node:path'
import * as filesystem from 'fs-extra'
import { binary } from '../install/tools.ts'

export type LlamaCppBuildVariant = 'standard' | 'ssd-offload'

type PhisonLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export const LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE =
  'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/aiDAPTIV_NXWVB306.1_x64.zip'
export const LLAMACPP_SSD_OFFLOAD_CONFIG_NAME = 'aidaptiv_config.json'
export const LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME = 'aidaptiv(303G0B).json'
export const LLAMACPP_SSD_OFFLOAD_EMBEDDING_CONFIG_NAME = 'aidaptiv_embedding_config.json'
export const LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT = 'wService_delete.bat'
export const LLAMACPP_SSD_OFFLOAD_CREATE_SERVICE_SCRIPT = 'wService_create.bat'
export const LLAMACPP_SSD_OFFLOAD_PROCESS_NAME = 'ada.exe'

const CONFIG_FILE_FLAG = '--config-file'

/**
 * Context window the aiDAPTIV embedding server is started with.
 *
 * Scoped to the ssd-offload build on purpose: the standard llama.cpp build keeps
 * llama-server's own default and is not affected by this value.
 *
 * RAG chunks are 512 *characters* (SPLITTER_PARAMS in langchain.ts), which is not
 * 512 tokens: CJK text tokenizes at roughly one token per character, so a full
 * chunk lands around 512 tokens plus the model's two special tokens. 768 gives
 * that headroom without reserving a window the embedding pass never uses.
 *
 * Deliberately one value for every model rather than a per-model table:
 * llama-server caps `--ctx-size` at the model's own `n_ctx_train` and logs that it
 * did, so a model trained on a shorter window still gets exactly its maximum.
 * bge-small-en-v1.5 (n_ctx_train 512) therefore runs at 512, the same window it
 * already ran at before this flag existed — llama-server capped its previous
 * default the same way — while nomic-embed (8192) and Qwen3-Embedding (32768)
 * get 768.
 *
 * Must stay <= the embedding server's `-ub`: embedding is non-causal and pooled,
 * so the whole sequence has to fit in a single physical batch.
 */
export const PHISON_EMBEDDING_CONTEXT_SIZE = 768

const LLAMA_CPP_SUBDIR_STANDARD = 'llama-cpp'
const LLAMA_CPP_SUBDIR_PHISON = 'llama-cpp-phison'

/**
 * aiDAPTIV offload budgets, in GB. `-1` is the current middleware's automatic
 * budget (NXWVB306.1). A fixed cap — the `10` this used to seed, or a `0` left
 * on disk — is what fails a large MoE load with MDW-EPC-0710.
 */
export const PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB = -1
export const PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB = -1

/**
 * Default for the aiDAPTIV config's `debug_log_path`.
 *
 * The service directory, not a fixed drive letter: the app created it, writes
 * the config file itself into it, and it exists on every machine. A hardcoded
 * `D:\` does not. Trailing separator kept: the previous values were drive roots
 * (`R:\`, `D:\`), so aiDAPTIV is given a path in the shape it already expected.
 */
export function defaultAidaptivPath(serviceDir: string): string {
  return path.resolve(serviceDir) + path.sep
}

/**
 * Deliberately carries no `offload_path`.
 *
 * Earlier aiDAPTIV middleware required the key and rejected a config without
 * it, so the app seeded the drive letter (`R:\`) these systems mounted the SSD
 * at. From NXWVB306.1 on, the runtime finds the aiDAPTIV device itself on a
 * machine provisioned without a drive letter — which is now how the hardware is
 * set up — and a hardcoded letter can only be wrong there: naming a drive the
 * SSD no longer answers to fails the load with `MDW-EPC-5003`, and naming one
 * that happens to exist but is not the SSD sends the spill to the system drive,
 * where the model dies on a Vulkan allocation blaming the GPU. Letting the
 * middleware detect the device is both correct and the only option that stays
 * correct when the machine changes.
 *
 * `debug_log_path` keeps its service-directory default: a log is not offload
 * traffic and has to land somewhere that exists on every machine.
 */
function ssdOffloadDefaultConfig(serviceDir: string) {
  return {
    common: {
      seed: '0',
      flash_attn: 'on',
      swa_full: true,
      threads: 10,
      mmap: false,
      context_shift: false,
      verbose: true,
      split_mode: 'none',
      parallel: 1,
      gpu_layers: '999',
    },
    aidaptiv: {
      debug_log_path: defaultAidaptivPath(serviceDir),
      dram_kv_offload_gb: 0,
      cache_kv_offload_gb: PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB,
      kv_cache_resume_policy: true,
      vram_experts_cached_gb: PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB,
    },
  }
}

/**
 * The embedding server's own aiDAPTIV config.
 *
 * Deliberately nothing but the aiDAPTIV block. There is no `common` block: the
 * embedding server is launched from the same startup-parameter string as the LLM,
 * so the llama.cpp side is already on its argv, and a copy of the LLM config's
 * `common` here would only be a second place to keep in sync. The offload
 * budgets (`cache_kv_offload_gb`, `vram_experts_cached_gb`) are left out too: an
 * embedding pass has no KV cache worth parking on the SSD and no experts worth
 * pinning in VRAM, so inheriting the LLM config's reservations would withhold
 * them from the LLM server for nothing. No `offload_path` either, for the same
 * reason the LLM config has none — the middleware detects the device.
 *
 * What is left is `debug_log_path`, which is per-config and has to point
 * somewhere that exists.
 */
function ssdOffloadEmbeddingDefaultConfig(serviceDir: string) {
  return {
    aidaptiv: {
      debug_log_path: defaultAidaptivPath(serviceDir),
    },
  }
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

export function getSsdOffloadEmbeddingConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_EMBEDDING_CONFIG_NAME))
}

export function getRelativeSsdOffloadConfigPath(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
  configPath: string,
): string {
  const relativePath = path.relative(getLlamaCppDirForVariant(serviceDir, variant), configPath)
  return relativePath || path.basename(configPath)
}

/**
 * Point an argv at `configPath` for `--config-file`.
 *
 * The startup-parameter string is a single setting shared by the LLM and the
 * embedding server, so in ssd-offload mode both inherit the `--config-file`
 * the renderer put there. This rewrites just that flag's value for the
 * embedding server, keeping every other flag the user typed. Both spellings
 * llama-server accepts are handled, and the flag is appended when the user
 * removed it.
 */
export function withConfigFileArg(args: string[], configPath: string): string[] {
  const out: string[] = []
  let replaced = false

  const emit = (token: string) => {
    if (replaced) return
    out.push(token, configPath)
    replaced = true
  }

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === CONFIG_FILE_FLAG) {
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('-')) i++
      emit(CONFIG_FILE_FLAG)
      continue
    }
    if (token.startsWith(`${CONFIG_FILE_FLAG}=`)) {
      if (!replaced) {
        out.push(`${CONFIG_FILE_FLAG}=${configPath}`)
        replaced = true
      }
      continue
    }
    out.push(token)
  }

  if (!replaced) out.push(CONFIG_FILE_FLAG, configPath)
  return out
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

/**
 * Trees that still hold the aiDAPTIV service binary or its delete script.
 * The selected variant can already be standard while ada.exe is locked in the
 * Phison tree, or in a legacy extract that landed in `llama-cpp/`.
 */
export function phisonCleanupDirs(serviceDir: string): string[] {
  const markers = [LLAMACPP_SSD_OFFLOAD_PROCESS_NAME, LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT]
  return [
    getLlamaCppDirForVariant(serviceDir, 'ssd-offload'),
    getLlamaCppDirForVariant(serviceDir, 'standard'),
  ].filter((dir) => markers.some((name) => filesystem.existsSync(path.join(dir, name))))
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
  filesystem.writeJsonSync(configPath, ssdOffloadDefaultConfig(serviceDir), { spaces: 2 })
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
  await filesystem.writeJson(configPath, ssdOffloadDefaultConfig(serviceDir), { spaces: 2 })
}

/**
 * Create the embedding server's config on first use. Unlike the LLM config
 * there is no legacy filename to migrate from — this file only ever existed
 * under its current name.
 */
export function ensureSsdOffloadEmbeddingConfigFileSync(
  serviceDir: string,
  configPath: string,
): void {
  if (filesystem.existsSync(configPath)) {
    return
  }

  filesystem.ensureDirSync(serviceDir)
  filesystem.writeJsonSync(configPath, ssdOffloadEmbeddingDefaultConfig(serviceDir), { spaces: 2 })
}

export async function ensureSsdOffloadEmbeddingConfigFile(
  serviceDir: string,
  configPath: string,
): Promise<void> {
  if (await filesystem.pathExists(configPath)) {
    return
  }

  await filesystem.ensureDir(serviceDir)
  await filesystem.writeJson(configPath, ssdOffloadEmbeddingDefaultConfig(serviceDir), {
    spaces: 2,
  })
}

/**
 * Bring an existing aiDAPTIV config up to date without disturbing the user's
 * own edits.
 *
 * Three repairs, all idempotent:
 *
 * - the legacy `ssd_kv_offload_gb` key becomes `cache_kv_offload_gb` (the
 *   `--ssd-kv-offload-gb` flag was renamed to `--cache-kv-offload-gb`);
 * - a `debug_log_path` pointing at a directory that no longer exists is reset to
 *   the service directory. Configs seeded by older builds name a drive that was
 *   only ever valid on the machine that picked it, and aiDAPTIV cannot log to a
 *   path that is not there;
 * - `offload_path` is dropped, `common.fit: "off"` is dropped, and the offload
 *   budgets are set to `-1`. The drive letter is the middleware's job now, and
 *   `fit: off` plus a fixed GB cap is what fails large-MoE loads on NXWVB306.1.
 *
 * The repairs reach existing installs deliberately. Changing what is *seeded*
 * only affects configs written from now on, so without a rewrite every machine
 * already in the field keeps `fit: off` and a fixed offload cap — the
 * combination that fails a large MoE load — until someone reinstalls the
 * backend or edits JSON by hand.
 *
 * Anything else the app does not know about survives this read-modify-write via
 * the spreads below.
 */
export async function reconcileSsdOffloadConfig(
  configPath: string,
  serviceDir: string,
  logger?: PhisonLogger,
): Promise<void> {
  if (!filesystem.existsSync(configPath)) {
    return
  }

  try {
    const config = await filesystem.readJson(configPath)
    const aidaptiv = { ...(config.aidaptiv ?? {}) }
    const common = { ...(config.common ?? {}) }
    const changes: string[] = []
    let commonChanged = false

    if ('ssd_kv_offload_gb' in aidaptiv) {
      if (!('cache_kv_offload_gb' in aidaptiv)) {
        aidaptiv.cache_kv_offload_gb = aidaptiv.ssd_kv_offload_gb
      }
      delete aidaptiv.ssd_kv_offload_gb
      changes.push('renamed ssd_kv_offload_gb to cache_kv_offload_gb')
    }

    const debugLogPath = aidaptiv.debug_log_path
    if (typeof debugLogPath !== 'string' || !filesystem.existsSync(debugLogPath)) {
      aidaptiv.debug_log_path = defaultAidaptivPath(serviceDir)
      changes.push(`reset unusable debug_log_path to ${aidaptiv.debug_log_path}`)
    }

    // Removed rather than corrected. The drive letter older builds wrote here
    // was a guess at where the SSD was mounted; the current middleware locates
    // the device itself, and on a machine provisioned without a letter — the
    // supported setup now — any value in this key names something that is not
    // the aiDAPTIV SSD. Keeping the user's is not the kinder option: a stale
    // letter fails the load with `MDW-EPC-5003`, and a live one that is merely
    // some other disk spills there and dies on a Vulkan allocation instead.
    if ('offload_path' in aidaptiv) {
      delete aidaptiv.offload_path
      changes.push('removed offload_path (the aiDAPTIV middleware detects the device)')
    }

    // `fit: off` disables llama.cpp's own fit pass. Large MoE models then fail
    // to come up under the Phison build. Any other value was typed by hand.
    if (common.fit === 'off') {
      delete common.fit
      commonChanged = true
      changes.push('removed fit: off')
    }

    // The LLM config carries these budgets; the embedding config deliberately
    // does not, and must not gain them. A fixed cap (including the `10` older
    // builds seeded and a `0` left on disk) fails the load, so anything other
    // than `-1` is brought back to the middleware's automatic budget.
    const isLlmConfig =
      config.common != null ||
      'kv_cache_resume_policy' in aidaptiv ||
      'dram_kv_offload_gb' in aidaptiv
    for (const [key, replacement] of [
      ['cache_kv_offload_gb', PHISON_DEFAULT_CACHE_KV_OFFLOAD_GB],
      ['vram_experts_cached_gb', PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB],
    ] as const) {
      if (!(key in aidaptiv) && !isLlmConfig) continue
      if (aidaptiv[key] === replacement) continue
      const previous = aidaptiv[key]
      aidaptiv[key] = replacement
      changes.push(
        previous === undefined ? `set ${key} to -1` : `set ${key} from ${previous} to -1`,
      )
    }

    if (changes.length === 0) {
      return
    }

    const nextConfig: Record<string, unknown> = { ...config, aidaptiv }
    if (commonChanged) {
      if (Object.keys(common).length === 0) delete nextConfig.common
      else nextConfig.common = common
    }
    await filesystem.writeJson(configPath, nextConfig, { spaces: 2 })
    logger?.info?.(`Reconciled ${path.basename(configPath)}: ${changes.join('; ')}`)
  } catch (error) {
    logger?.warn?.(`Failed to reconcile SSD offload config: ${error}`)
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

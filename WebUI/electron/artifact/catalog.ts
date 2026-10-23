/**
 * Main-side preset catalog for the artifact runner
 * (docs/architecture-target.md §4.1, step 5).
 *
 * Renderer drivers (the panel, chat tools, Home Agent) ship a resolved preset
 * entry with their run request, but the in-process agent direct tools construct
 * requests from workflow names at execution time — so main needs the same view
 * of the preset list the renderer has: the bundled base+mode files (with the
 * mode/product filters applied), user presets, and the dev-only dummy
 * workflows behind the debug gate.
 *
 * File reading and filtering are moved verbatim from `electron/main.ts`
 * (previous location of `readPresetsFromDir`/`applyPresetFilter`); the catalog
 * additionally validates each file against the shared zod schemas
 * (`@/lib/presetSchemas`) so a resolved entry handed to the runner is known
 * good. Invalid files are warned about and skipped, mirroring the renderer's
 * per-preset validation.
 */
import path from 'node:path'
import fs from 'fs'
import { app } from 'electron'
import { appLoggerInstance } from '../observability/logger'
import {
  PresetSchema,
  applyVariant,
  getFirstVariantName,
  type ChatPreset,
  type ComfyUiPreset,
  type Preset,
} from '@/lib/presetSchemas'
import { devPresets } from '@/lib/devPresetWorkflows'

const appLogger = appLoggerInstance

export type PresetLoadConfig = {
  baseDir: string
  modeDir: string
  imageFallbackDirs: string[]
  includePresets?: string[]
  excludePresets?: string[]
  excludeVariantBackends?: string[]
}

export type PresetFile = { content: string; image: string | null }

function findPresetImage(baseName: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const ext of ['.png', '.jpg', '.jpeg']) {
      const imagePath = path.join(dir, `${baseName}${ext}`)
      if (fs.existsSync(imagePath)) return imagePath
    }
  }
  return null
}

export async function readPresetsFromDir(
  dir: string,
  imageFallbackDirs: string[] = [],
): Promise<Map<string, PresetFile>> {
  const result = new Map<string, PresetFile>()
  if (!fs.existsSync(dir)) return result

  await fs.promises.mkdir(dir, { recursive: true })
  const files = await fs.promises.readdir(dir)
  const presetFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('_'))

  await Promise.all(
    presetFiles.map(async (file) => {
      const raw = await fs.promises.readFile(path.join(dir, file), { encoding: 'utf-8' })
      const content = process.platform !== 'win32' ? raw.replaceAll('\\\\', '/') : raw

      const baseName = path.basename(file, '.json')
      let imageBase64: string | null = null
      const imagePath = findPresetImage(baseName, [dir, ...imageFallbackDirs])
      if (imagePath) {
        try {
          const imageBuffer = await fs.promises.readFile(imagePath)
          const ext = path.extname(imagePath).toLowerCase()
          const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
          imageBase64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
        } catch (error) {
          appLogger.warn(`Failed to read image file ${imagePath}: ${error}`, 'electron-backend')
        }
      }

      result.set(baseName, { content, image: imageBase64 })
    }),
  )
  return result
}

function applyPresetFilter(
  presets: Map<string, PresetFile>,
  config: PresetLoadConfig,
): Map<string, PresetFile> {
  if (config.includePresets) {
    const allowed = new Set(config.includePresets)
    for (const key of presets.keys()) {
      if (!allowed.has(key)) presets.delete(key)
    }
  } else if (config.excludePresets) {
    for (const excluded of config.excludePresets) {
      presets.delete(excluded)
    }
  }
  if (config.excludeVariantBackends?.length) {
    const excludedBackends = new Set(config.excludeVariantBackends)
    for (const [key, file] of presets) {
      try {
        const parsed = JSON.parse(file.content)
        if (parsed?.type !== 'comfy' || !Array.isArray(parsed.variants)) continue
        const filtered = parsed.variants.filter(
          (v: { backend?: string }) => !(v?.backend && excludedBackends.has(v.backend)),
        )
        if (filtered.length === parsed.variants.length) continue
        parsed.variants = filtered
        presets.set(key, { ...file, content: JSON.stringify(parsed) })
      } catch (e) {
        appLogger.warn(`Failed to filter variants for preset "${key}": ${e}`, 'electron-backend')
      }
    }
  }
  return presets
}

/**
 * The same base+mode merge the `reloadPresets` IPC handler serves the
 * renderer: base presets filtered by the mode config, mode presets layered on
 * top by name. (Partner filtering happens in the caller before reading.)
 */
export async function loadPresetFiles(config: PresetLoadConfig): Promise<PresetFile[]> {
  const basePresets = applyPresetFilter(
    await readPresetsFromDir(config.baseDir, config.imageFallbackDirs),
    config,
  )
  const modePresets = await readPresetsFromDir(config.modeDir, config.imageFallbackDirs)
  for (const [name, preset] of modePresets) {
    basePresets.set(name, preset)
  }
  return [...basePresets.values()]
}

export type PresetCatalog = {
  comfy: Map<string, ComfyUiPreset>
  chat: Map<string, ChatPreset>
}

/** Parses and validates preset files into the catalog, skipping invalid ones. */
export function buildPresetCatalog(
  files: PresetFile[],
  options: { includeDevPresets?: boolean } = {},
): PresetCatalog {
  const catalog: PresetCatalog = { comfy: new Map(), chat: new Map() }
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch (e) {
      appLogger.warn(`Skipping preset file that failed to parse: ${e}`, 'electron-backend')
      continue
    }
    const preset = PresetSchema.safeParse(parsed)
    if (!preset.success) {
      appLogger.warn(
        `Skipping invalid preset "${(parsed as { name?: string })?.name ?? '<unnamed>'}": ${preset.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        'electron-backend',
      )
      continue
    }
    if (preset.data.type === 'comfy') catalog.comfy.set(preset.data.name, preset.data)
    else catalog.chat.set(preset.data.name, preset.data)
  }
  if (options.includeDevPresets) {
    // After the file presets: the dummies are guaranteed present under their
    // fixed names, and their names never collide with real workflows.
    for (const preset of devPresets) catalog.comfy.set(preset.name, preset)
  }
  return catalog
}

function getUserPresetsDir(): string {
  return path.join(app.getPath('documents'), 'AI Playground', 'presets')
}

let catalogCache: Promise<PresetCatalog> | null = null

/** Drops the memoized catalog; call after any mutation that can change it. */
export function invalidatePresetCatalog(): void {
  catalogCache = null
}

/**
 * The catalog main serves itself from, memoized until invalidated. Reads
 * bundled base+mode presets, user presets and (behind the debug gate) the dev
 * dummy workflows.
 */
export function getPresetCatalog(
  config: PresetLoadConfig,
  includeDevPresets: boolean,
): Promise<PresetCatalog> {
  if (!catalogCache) {
    catalogCache = (async () => {
      const [bundled, user] = await Promise.all([
        loadPresetFiles(config),
        readPresetsFromDir(getUserPresetsDir()),
      ])
      return buildPresetCatalog([...bundled, ...user.values()], { includeDevPresets })
    })()
  }
  return catalogCache
}

/**
 * A resolved comfy preset entry the runner can mutate freely (workflow input
 * substitution): variant applied — an unknown name falls back to the base, the
 * first variant when none is requested — and deep-cloned.
 */
export function resolveComfyEntry(
  catalog: PresetCatalog,
  name: string,
  variant?: string,
): ComfyUiPreset | null {
  const base = catalog.comfy.get(name)
  if (!base) return null
  const requested = variant ?? getFirstVariantName(base) ?? undefined
  const resolved: Preset = requested ? applyVariant(base, requested) : base
  return structuredClone(resolved) as ComfyUiPreset
}

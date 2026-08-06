import fs from 'node:fs'
import path from 'node:path'
import { packagedResourcesRoot, writableConfigRoot } from './aipgRoot.ts'

/**
 * Resolves a mutable config file's path in this user's writable config root,
 * lazily seeding it from the shared read-only default on first use.
 *
 * In a shared all-users install `writableConfigRoot()` is a private per-user
 * directory separate from the shared resources root, so each user gets their own
 * copy of `settings.json`, `model_config.json`, `mcp.json`, etc., seeded once
 * from the machine-wide default. In every other mode `writableConfigRoot()`
 * equals `packagedResourcesRoot()`, so this is a plain passthrough and behaviour
 * is unchanged.
 */
export function writableConfigFile(fileName: string): string {
  const configRoot = writableConfigRoot()
  const target = path.join(configRoot, fileName)

  // Non-shared modes: config root === resources root, nothing to seed.
  if (configRoot === packagedResourcesRoot()) return target

  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const seed = path.join(packagedResourcesRoot(), fileName)
      if (fs.existsSync(seed)) fs.copyFileSync(seed, target)
    }
  } catch (e) {
    console.error(`[userConfig] failed to seed ${fileName}:`, e)
  }
  return target
}

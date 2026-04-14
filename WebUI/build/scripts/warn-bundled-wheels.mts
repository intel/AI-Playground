#!/usr/bin/env node
/**
 * Post electron-builder: warn when build-config extraResources bundle custom .whl files.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { REPO_ROOT } from './build-paths.mts'

const WEBUI_ROOT = join(REPO_ROOT, 'WebUI')
const BUILD_CONFIG_PATH = join(WEBUI_ROOT, 'build', 'build-config.json')

type ExtraResource =
  | string
  | {
      from?: string
      filter?: string[]
    }

function filterBundlesWhl(filter: string[] | undefined): boolean {
  if (!filter?.length) return false
  return filter.some((f) => f.toLowerCase().includes('.whl'))
}

function whlSourceDirs(extraResources: ExtraResource[] | undefined): string[] {
  const dirs: string[] = []
  if (!extraResources) return dirs
  for (const entry of extraResources) {
    if (typeof entry === 'string') continue
    if (!entry.from || !filterBundlesWhl(entry.filter)) continue
    dirs.push(resolve(WEBUI_ROOT, entry.from))
  }
  return dirs
}

function listWhlFiles(fromPath: string): string[] {
  if (!existsSync(fromPath)) return []
  const st = statSync(fromPath)
  if (st.isFile() && fromPath.toLowerCase().endsWith('.whl')) return [fromPath]
  if (!st.isDirectory()) return []
  return readdirSync(fromPath)
    .filter((name) => name.toLowerCase().endsWith('.whl'))
    .map((name) => join(fromPath, name))
}

function main(): void {
  const config = JSON.parse(readFileSync(BUILD_CONFIG_PATH, 'utf8')) as {
    extraResources?: ExtraResource[]
  }
  const sources = whlSourceDirs(config.extraResources)
  if (sources.length === 0) return

  const bundled: string[] = []
  for (const src of sources) {
    bundled.push(...listWhlFiles(src))
  }
  if (bundled.length === 0) return

  const rel = (p: string) => relative(WEBUI_ROOT, p) || p
  console.warn('')
  console.warn('================================================================================')
  console.warn('WARNING: This build bundles custom Python wheel files (.whl).')
  console.warn('         Source: extraResources in WebUI/build/build-config.json')
  console.warn('')
  for (const p of bundled) {
    console.warn(`         - ${rel(p)}`)
  }
  console.warn('================================================================================')
  console.warn('')
}

main()

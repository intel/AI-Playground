import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { app } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import type { SkillSource } from '../piCustomTools.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

// ── memory capability (pi-hermes-memory) ─────────────────────────────────────
//
// The one capability that is a real third-party Pi extension rather than an
// inline factory: `pi-hermes-memory` ships as TypeScript sources with a `pi`
// manifest, so Pi's own loader (jiti) reads it from node_modules. It gives the
// agent memory/user/project notes that survive across sessions, a learning loop
// that saves notable facts on its own, SQLite session search, and procedural
// skills it writes itself.
//
// Two things it expects from the host:
//
//  - `PI_CODING_AGENT_DIR`: the package resolves its root ONCE at module load
//    (`AGENT_ROOT` in its paths.ts), so the env var has to be set before Pi
//    imports it. Pointing it at our agent dir keeps everything the extension
//    writes inside the app's userData, next to Pi's own state.
//  - `hermes-memory-config.json` in that dir: written here so the settings are
//    the app's, not whatever the package defaults to next release.

const logger = appLoggerInstance
const LOG_SOURCE = 'capabilities/memory'

const PACKAGE_NAME = 'pi-hermes-memory'
/** The package's Pi extension entry, from its own `pi.extensions` manifest. */
const EXTENSION_ENTRY = `${PACKAGE_NAME}/src/index.ts`
/** Where the extension keeps memory, skills and its SQLite index. */
const MEMORY_DIR_NAME = PACKAGE_NAME
/**
 * The extension stores everything in SQLite through this native addon, so
 * without a binary built for Electron's ABI every memory tool fails on its first
 * call. `build/scripts/ensure-native-modules.mjs` fetches it (dev) and
 * electron-builder's `npmRebuild` does (packaged).
 */
const NATIVE_MODULE = 'better-sqlite3'
const NATIVE_BINARY = path.join('build', 'Release', 'better_sqlite3.node')

/**
 * Config the extension reads on load. Deliberately explicit: `memoryDir` so the
 * data lives in our agent dir even if the package changes its default, and
 * `reviewTransport: 'direct'` because the 'subprocess' path shells out to a `pi`
 * CLI the app does not ship.
 */
function hermesConfig(memoryDir: string): Record<string, unknown> {
  return {
    memoryDir,
    memoryMode: 'policy-only',
    reviewEnabled: true,
    reviewTransport: 'direct',
    // Every review and consolidation is a full extra model call on the user's
    // own hardware, so they stay rare: once per 10 assistant turns (the
    // package's own default) and only after a session has some substance.
    nudgeInterval: 10,
    flushMinTurns: 6,
    flushOnCompact: true,
    flushOnShutdown: true,
    correctionDetection: true,
    autoConsolidate: true,
  }
}

/**
 * Path of the extension entry, or undefined when the package is missing from
 * this build. Node's own resolution first; the app path is the fallback for the
 * packaged bundle, where the main process is a single CJS file and its module
 * paths do not necessarily lead to the app's node_modules.
 */
function extensionEntryPath(): string | undefined {
  const candidates: string[] = []
  try {
    candidates.push(createRequire(import.meta.url).resolve(EXTENSION_ENTRY))
  } catch {
    // Not resolvable from here — the app-path candidates below still apply.
  }
  try {
    candidates.push(path.join(app.getAppPath(), 'node_modules', PACKAGE_NAME, 'src', 'index.ts'))
  } catch {
    // No Electron app object in a plain Node context (tests).
  }
  for (const candidate of candidates) {
    // In a packaged build the sources are unpacked next to the asar, so jiti can
    // compile them and better-sqlite3's .node can be loaded at all.
    const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    if (unpacked !== candidate && fs.existsSync(unpacked)) return unpacked
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Path of the extension's SQLite addon, or undefined when this build has none
 * that Electron can load. Checked before the capability is offered, because the
 * failure mode otherwise is every memory tool call erroring mid-turn.
 */
function nativeBinaryPath(): string | undefined {
  const candidates: string[] = []
  try {
    const manifest = createRequire(import.meta.url).resolve(`${NATIVE_MODULE}/package.json`)
    candidates.push(path.join(path.dirname(manifest), NATIVE_BINARY))
  } catch {
    // Not resolvable from here — the app-path candidate below still applies.
  }
  try {
    candidates.push(path.join(app.getAppPath(), 'node_modules', NATIVE_MODULE, NATIVE_BINARY))
  } catch {
    // No Electron app object in a plain Node context (tests).
  }
  for (const candidate of candidates) {
    const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    if (unpacked !== candidate && fs.existsSync(unpacked)) return unpacked
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Point the extension at our agent dir and write its config. Runs before Pi
 * loads the extension file, which is what makes the env var effective.
 */
function prepareHermes(host: CapabilityHost): void {
  process.env.PI_CODING_AGENT_DIR = host.agentDir
  const memoryDir = path.join(host.agentDir, MEMORY_DIR_NAME)
  try {
    fs.mkdirSync(memoryDir, { recursive: true })
    fs.writeFileSync(
      path.join(host.agentDir, 'hermes-memory-config.json'),
      `${JSON.stringify(hermesConfig(memoryDir), null, 2)}\n`,
    )
  } catch (error) {
    logger.warn(`failed to write the memory config: ${error}`, LOG_SOURCE)
  }
}

/**
 * Everything the extension has learned to do, as skills the model can read.
 * Taken over from its own `resources_discover` because that announces host
 * paths, which the sandboxed `read` tool cannot open; going through the app's
 * skill machinery puts them where the model is actually looking. A skill the
 * agent writes mid-session therefore shows up in the next session build, which
 * is also when the extension itself re-reads them.
 */
function readGeneratedSkills(host: CapabilityHost): SkillSource[] {
  const roots = [
    path.join(host.agentDir, MEMORY_DIR_NAME, 'skills'),
    ...projectSkillRoots(path.join(host.agentDir, 'projects-memory')),
  ]
  const sources: SkillSource[] = []
  for (const root of roots) {
    for (const entry of readDirNames(root)) {
      const skill = readSkillFile(path.join(root, entry, 'SKILL.md'))
      if (skill && !sources.some((existing) => existing.name === skill.name)) sources.push(skill)
    }
  }
  if (sources.length > 0) {
    logger.info(`memory contributed ${sources.length} learned skill(s)`, LOG_SOURCE)
  }
  return sources
}

/** The extension stores per-project skills under `projects-memory/<project>/skills`. */
function projectSkillRoots(projectsRoot: string): string[] {
  return readDirNames(projectsRoot).map((project) => path.join(projectsRoot, project, 'skills'))
}

function readDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Parse a SKILL.md into the app's skill shape. The frontmatter is the package's
 * own (`name`, `description`); anything unparseable is skipped rather than
 * announced with a broken description.
 */
function readSkillFile(filePath: string): SkillSource | undefined {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return undefined
  const [, frontmatter, body] = match
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(frontmatter)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
  const name = field('name')
  const description = field('description')
  if (!name || !description) return undefined
  return { name, description, body: body.trim() }
}

export const memoryCapability: AgentCapability = {
  id: 'memory',
  label: 'Persistent memory',
  summary:
    'Remember facts, preferences and procedures across sessions, search past sessions, and ' +
    'write skills from what worked.',
  commands: [
    { command: '/memory-insights', description: 'Show what is currently remembered.' },
    { command: '/memory-skills', description: 'List the procedures the agent has written down.' },
    { command: '/memory-consolidate', description: 'Merge and tidy up stored memory.' },
    { command: '/memory-index-sessions', description: 'Index past sessions for search.' },
  ],
  // The extension's value is its hooks (it saves memory during and after every
  // turn), so it is never parked as a dormant tool set.
  lazyEligible: false,
  buildSkills: readGeneratedSkills,
  extensionPaths: (host) => {
    const entry = extensionEntryPath()
    if (!entry) return []
    prepareHermes(host)
    return [entry]
  },
  unavailableReason: () => {
    if (!extensionEntryPath()) return `${PACKAGE_NAME} is not installed in this build.`
    if (!nativeBinaryPath()) {
      logger.warn(
        `${NATIVE_MODULE} has no Electron build; run 'npm run ensure-native-modules'`,
        LOG_SOURCE,
      )
      return `Its database module (${NATIVE_MODULE}) is missing from this build.`
    }
    return undefined
  },
}

export const testables = { hermesConfig, readSkillFile, readGeneratedSkills, nativeBinaryPath }

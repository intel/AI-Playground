import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { externalResourcesDir } from './util.ts'

// ── Sample games shipped with the app ────────────────────────────────────────
//
// Acer asked for the arcade to hold games on a machine nobody has built one on
// yet, so four are bundled (`WebUI/external/arcade-samples`, an `extraResources`
// entry in the packaged build) and copied into the library root whenever the Acer
// gallery is written.
//
// They land in a nested folder on purpose. `listGames()` reads `game.json` from
// the library root's immediate children, so a sample under `_arcade-samples/` is
// invisible to it: it never shows up in the Game Agent session list and can never
// become an agent workspace. It is something to play, not a draft to continue.
// `library.json` leaves them out for the same reason — it is the upload input for
// the games the user made.

/** Bundle directory name, under the external resources root. */
const BUNDLE_DIR = 'arcade-samples'
const INDEX_FILE = 'samples.json'
const HIDDEN_FILE = 'arcade-hidden.json'

/** Where the copies live, relative to the library root. */
export const SAMPLES_FOLDER = '_arcade-samples'

const SamplesIndexSchema = z.object({ games: z.array(z.string()) })
const HiddenSchema = z.object({ samples: z.array(z.string()).default([]) })

/**
 * The bundled samples directory, or null when there is no answer — a build
 * without them, or a unit test with no Electron paths. The gallery is written on
 * every arcade open, so a miss here must degrade to "no samples" rather than
 * fail it.
 */
function bundleDir(): string | null {
  try {
    return path.join(externalResourcesDir(), BUNDLE_DIR)
  } catch {
    return null
  }
}

/** A folder name from the bundle index that cannot escape the bundle. */
function isSafeSlug(slug: string): boolean {
  return slug.length > 0 && !slug.includes('/') && !slug.includes('\\') && slug !== '..'
}

/**
 * Which samples to install, in the order they should show. `samples.json` is the
 * order the stakeholder asked for; without it the folders are taken as they sort,
 * so a bundle that lost its index still works.
 */
function sampleSlugs(source: string): string[] {
  try {
    const parsed = SamplesIndexSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(source, INDEX_FILE), 'utf-8')),
    )
    if (parsed.success) return parsed.data.games.filter(isSafeSlug)
  } catch {
    // No index, or an unreadable one: fall back to the folders themselves.
  }
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Copy the bundled samples into `<root>/_arcade-samples/`, returning the folder
 * names that made it, in bundle order. Existing copies are overwritten, so an app
 * update refreshes a sample the next time the arcade is opened.
 *
 * `samplesRoot` is the bundle to install from: omitted it resolves to the app's
 * own, and `null` installs nothing.
 */
/**
 * Sample slugs the user took out of the arcade.
 *
 * It cannot be `published: false` on the installed copy: every arcade write
 * recopies the bundle over it, so the flag would be wiped. The list lives in the
 * library root instead, which also puts it outside the app — a reinstall keeps it.
 */
export function hiddenSamples(root: string): Set<string> {
  try {
    const parsed = HiddenSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(root, HIDDEN_FILE), 'utf-8')),
    )
    return new Set(parsed.success ? parsed.data.samples : [])
  } catch {
    return new Set()
  }
}

/** Take a sample out of the arcade, or put it back. */
export function setSampleHidden(root: string, slug: string, hidden: boolean): void {
  if (!isSafeSlug(slug)) throw new Error(`Not a sample game: ${slug}`)
  const samples = hiddenSamples(root)
  if (hidden) samples.add(slug)
  else samples.delete(slug)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, HIDDEN_FILE),
    `${JSON.stringify({ samples: [...samples] }, null, 2)}\n`,
    'utf-8',
  )
}

export function installArcadeSamples(root: string, samplesRoot?: string | null): string[] {
  const source = samplesRoot === undefined ? bundleDir() : samplesRoot
  if (!source || !fs.existsSync(source)) return []
  const installed: string[] = []
  for (const slug of sampleSlugs(source)) {
    const from = path.join(source, slug)
    if (!fs.existsSync(path.join(from, 'game.json'))) continue
    try {
      fs.cpSync(from, path.join(root, SAMPLES_FOLDER, slug), { recursive: true, force: true })
      installed.push(slug)
    } catch {
      // One unreadable sample must not cost the others.
    }
  }
  return installed
}

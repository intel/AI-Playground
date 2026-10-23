import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS } from '@/types/ipcChannels'

// The two textual leftovers of registration enforcement (#301 final form).
// Handler completeness and owner placement are compile-time now: every
// manifest row registers through a per-owner registry literal that
// `satisfies` an owner-scoped mapped type (electron/kernel/ipcRegistries.ts),
// so a missing handler or an unhandled new row is a build error — pinned by
// the planted-omission fixture in ipcRegistries.test.ts — and a homeAgent key
// cannot satisfy a Main* map (or vice versa). What a type cannot see survives
// here as source-text scans: raw `ipcMain.handle`/`ipcMain.on`/
// `webContents.send`/`ipcRenderer.*` registrations bypass the typed seam
// entirely, so the allowlist below stays forever, and every `push` row still
// needs a preload `onPush`/`onRaw` listener until #303 derives the bridge
// members from the manifest.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON_DIR = path.resolve(__dirname, '..', '..')

type RawKind =
  'handle' | 'on' | 'send' | 'preload-invoke' | 'preload-on' | 'preload-send' | 'listen'

type RawSite = { file: string; channel: string; kind: RawKind }

// The kernel event stream is the one documented raw exception (ADR-0001): the
// bus pushes over plain `webContents.send` and preload subscribes through the
// raw `listen` helper. It has no manifest row by design — see
// `IpcExtraBridgeMembers.onKernelEvent` in src/types/ipcChannels.ts.
const RAW_ALLOWLIST: RawSite[] = [
  { file: path.join('kernel', 'kernelBus.ts'), channel: 'kernel:event', kind: 'send' },
  { file: 'preload.ts', channel: 'kernel:event', kind: 'listen' },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'test' && path.dirname(full) === ELECTRON_DIR) continue
      out.push(...walk(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function scanRaw(): RawSite[] {
  const raw: RawSite[] = []
  for (const file of walk(ELECTRON_DIR)) {
    const source = readFileSync(file, 'utf8')
    const rel = path.relative(ELECTRON_DIR, file)
    // Same-file `const NAME = 'channel'` declarations (kernelBus's event channel).
    const consts = new Map<string, string>()
    for (const m of source.matchAll(/const ([A-Za-z_$][\w$]*) = '([^']+)'/g)) consts.set(m[1], m[2])
    const channelOf = (token: string): string | null => {
      const literal = /^'([^']+)'$/.exec(token)
      if (literal) return literal[1]
      return consts.get(token) ?? null
    }
    for (const [pattern, kind] of [
      [/\bipcMain\.handle\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'handle'],
      [/\bipcMain\.on\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'on'],
      [/\bwebContents\.send\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'send'],
      [/\bipcRenderer\.invoke\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-invoke'],
      [/\bipcRenderer\.on\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-on'],
      [/\bipcRenderer\.send\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-send'],
      [/\blisten\(\s*'([^']+)'/gs, 'listen'],
    ] as const) {
      for (const m of source.matchAll(pattern)) {
        const channel = channelOf(m[1])
        if (channel !== null) raw.push({ file: rel, channel, kind })
      }
    }
  }
  return raw
}

const RAW_SITES = scanRaw()

describe('channel manifest registration scan', () => {
  const rows = Object.entries(CHANNELS).map(([name, row]) => ({
    name,
    kind: row.kind,
  }))

  it('subscribes every push row through a preload listener', () => {
    const preload = readFileSync(path.join(ELECTRON_DIR, 'preload.ts'), 'utf8')
    const listened = new Set(
      [...preload.matchAll(/\bon(?:Push|Raw)\(\s*'([^']+)'/gs)].map((m) => m[1]),
    )
    const missing = rows
      .filter((r) => r.kind === 'push' && !listened.has(r.name))
      .map((r) => `push '${r.name}' has no onPush/onRaw listener in preload.ts`)
    expect(missing).toEqual([])
  })

  it('has no raw registrations outside the kernel-stream allowlist', () => {
    const strays = RAW_SITES.filter(
      (site) =>
        !RAW_ALLOWLIST.some(
          (allowed) =>
            allowed.file === site.file &&
            allowed.channel === site.channel &&
            allowed.kind === site.kind,
        ),
    ).map((site) => `${site.file}: raw ${site.kind} on '${site.channel}'`)
    expect(strays).toEqual([])
  })
})

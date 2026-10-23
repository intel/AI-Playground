import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CHANNELS,
  type BridgeMemberFor,
  type ElectronApi,
  type NamespaceBridge,
} from '@/types/ipcChannels'

// Compile-time derivation tests: vue-tsc enforces every assertion here (an
// `expectTypeOf` mismatch is a type error), while vitest runs the blocks as
// trivially green. They pin the three `member`-override placement rules.

describe('channel manifest bridge-path derivation', () => {
  it('places a dotted-member channel at its cross-group path', () => {
    expectTypeOf<ElectronApi['homeAgent']['saveDocument']>().toEqualTypeOf<
      BridgeMemberFor<'saveHomeAgentDocument'>
    >()
    expectTypeOf<ElectronApi>().not.toHaveProperty('saveHomeAgentDocument')
  })

  it('places a dotted member inside a nested sub-group', () => {
    expectTypeOf<ElectronApi['homeAgent']['channel']['saveConfig']>().toEqualTypeOf<
      BridgeMemberFor<'channel:saveConfig'>
    >()
    expectTypeOf<NamespaceBridge<'homeAgent'>>().not.toHaveProperty('saveConfig')
  })

  it('derives ns:sub:leaf channels two levels deep without an override', () => {
    expectTypeOf<ElectronApi['homeAgent']['localWeb']['getUrls']>().toEqualTypeOf<
      BridgeMemberFor<'homeAgent:localWeb:getUrls'>
    >()
    expectTypeOf<NamespaceBridge<'homeAgent'>>().not.toHaveProperty('getUrls')
  })

  it('places a flat-flagged namespaced channel at the top level', () => {
    expectTypeOf<ElectronApi['setLifecycleBusy']>().toEqualTypeOf<
      BridgeMemberFor<'lifecycle:busy'>
    >()
    expectTypeOf<ElectronApi>().not.toHaveProperty('lifecycle')
  })

  it('keeps a dot-less member override a leaf rename inside its own group', () => {
    expectTypeOf<NamespaceBridge<'agentMode'>['submitToolResult']>().toEqualTypeOf<
      BridgeMemberFor<'agentMode:toolResult'>
    >()
    expectTypeOf<NamespaceBridge<'agentMode'>>().not.toHaveProperty('toolResult')
    expectTypeOf<ElectronApi>().not.toHaveProperty('submitToolResult')
  })

  it('derives the raw push listener under its on-prefixed member name', () => {
    expectTypeOf<NamespaceBridge<'webBrowser'>['onStateChanged']>().toEqualTypeOf<
      BridgeMemberFor<'webBrowser:stateChanged'>
    >()
    // raw: the renderer listener returns no unsubscribe
    expectTypeOf<
      ReturnType<NamespaceBridge<'webBrowser'>['onStateChanged']>
    >().toEqualTypeOf<void>()
  })

  it('keeps every migrated group member reachable through its derived path', () => {
    expectTypeOf<ElectronApi['webBrowser']['navigate']>().toEqualTypeOf<
      BridgeMemberFor<'webBrowser:navigate'>
    >()
    expectTypeOf<ElectronApi['homeAgent']['channel']['send']>().toEqualTypeOf<
      BridgeMemberFor<'channel:send'>
    >()
  })
})

// ── Runtime uniqueness walk ────────────────────────────────────────────────
// The type-level derivation merges a collision instead of rejecting it (a leaf
// and a group with the same path unify into one property), so uniqueness is a
// runtime check. `bridgePathOf` mirrors the type-level `BridgePath` rule;
// the pinned `expectTypeOf` cases above tie the mirror to the real placements.

type RowLike = { kind: string; member?: string; flat?: boolean }

function bridgePathOf(name: string, row: RowLike): string[] {
  const parents = name.includes(':') ? name.split(':').slice(0, -1) : []
  if (row.member !== undefined) {
    return row.member.includes('.')
      ? row.member.split('.')
      : row.flat
        ? [row.member]
        : [...parents, row.member]
  }
  const leafBase = name.includes(':') ? (name.split(':').pop() as string) : name
  const leaf = row.kind === 'push' ? `on${leafBase[0].toUpperCase()}${leafBase.slice(1)}` : leafBase
  return row.flat ? [leaf] : [...parents, leaf]
}

/** Two ways derived paths can collide: a full duplicate, and a leaf that
 *  shadows the group below it (`a` vs `a.b`). */
function collisions(entries: { name: string; path: string[] }[]): string[] {
  const findings: string[] = []
  const byPath = new Map<string, string[]>()
  for (const entry of entries) {
    const key = entry.path.join('/')
    byPath.set(key, [...(byPath.get(key) ?? []), entry.name])
  }
  for (const [key, names] of byPath) {
    if (names.length > 1) findings.push(`path [${key.split('/')}] claimed by ${names.join(', ')}`)
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue
      const short = entries[i].path
      const long = entries[j].path
      if (short.length >= long.length) continue
      if (long.slice(0, short.length).join('/') === short.join('/')) {
        findings.push(
          `${entries[i].name} leaf [${short}] shadows the group of ${entries[j].name} [${long}]`,
        )
      }
    }
  }
  return findings
}

// IpcExtraBridgeMembers: hand-wired members with no manifest row (webUtils
// getFilePath, the raw kernel-stream listener) — same top-level namespace.
const EXTRA_BRIDGE_PATHS: { name: string; path: string[] }[] = [
  { name: '(extra) getFilePath', path: ['getFilePath'] },
  { name: '(extra) onKernelEvent', path: ['onKernelEvent'] },
]

describe('channel manifest bridge-path uniqueness', () => {
  const rowPaths = Object.entries(CHANNELS).map(([name, row]) => ({
    name,
    path: bridgePathOf(name, row as RowLike),
  }))

  it('places every row (plus the two extra members) on a unique, non-shadowing path', () => {
    expect(collisions([...rowPaths, ...EXTRA_BRIDGE_PATHS])).toEqual([])
  })

  it('mirrors the type-level placement the pinned rows above assert', () => {
    const pathOf = (name: keyof typeof CHANNELS) => bridgePathOf(name, CHANNELS[name] as RowLike)
    expect(pathOf('saveHomeAgentDocument')).toEqual(['homeAgent', 'saveDocument'])
    expect(pathOf('channel:saveConfig')).toEqual(['homeAgent', 'channel', 'saveConfig'])
    expect(pathOf('homeAgent:localWeb:getUrls')).toEqual(['homeAgent', 'localWeb', 'getUrls'])
    expect(pathOf('lifecycle:busy')).toEqual(['setLifecycleBusy'])
    expect(pathOf('agentMode:toolResult')).toEqual(['agentMode', 'submitToolResult'])
    expect(pathOf('webBrowser:stateChanged')).toEqual(['webBrowser', 'onStateChanged'])
    expect(pathOf('kernel:getSnapshot')).toEqual(['getKernelSnapshot'])
    expect(pathOf('show-toast')).toEqual(['onShowToast'])
    expect(pathOf('display-metrics-changed')).toEqual(['screenChange'])
  })

  it('catches a planted duplicate and a planted leaf-vs-group shadow', () => {
    const planted = Object.entries({
      'ns:dupA': { kind: 'invoke', member: 'group.same' },
      'ns:dupB': { kind: 'invoke', member: 'group.same' },
      topLeaf: { kind: 'invoke', flat: true },
      'topLeaf:child': { kind: 'invoke' },
    } satisfies Record<string, RowLike>).map(([name, row]) => ({
      name,
      path: bridgePathOf(name, row),
    }))

    const found = collisions(planted)
    expect(found.some((f) => f.includes('ns:dupA') && f.includes('ns:dupB'))).toBe(true)
    expect(found.some((f) => f.includes('topLeaf') && f.includes('shadows'))).toBe(true)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HELP_PANEL_ID,
  HELP_TOGGLE_ID,
  HELP_TOPICS,
  getHelpTopic,
  resolveHelpTarget,
} from '@/assets/js/help/helpTopics'
import { TOUR_ONLY_ANCHORS, TOUR_STEPS, TOUR_STEPS_ALTERNATIVE } from '@/assets/js/help/tourSteps'

const tourOnly = new Set<string>(TOUR_ONLY_ANCHORS)

describe('help topic registry', () => {
  it('gives every demo-tour anchor a click-to-learn topic', () => {
    const anchors = [...TOUR_STEPS, ...TOUR_STEPS_ALTERNATIVE]
      .map((step) => step.id)
      .filter((id) => !tourOnly.has(id))

    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) {
      expect(
        getHelpTopic(anchor.replace('#', '')),
        `missing help topic for ${anchor}`,
      ).toBeDefined()
    }
  })

  // The tour may point at help mode's own chrome; the click-to-learn layer must not,
  // or clicking the toggle in help mode would try to explain the toggle.
  it('keeps tour-only anchors out of the click-to-learn topics', () => {
    expect(TOUR_ONLY_ANCHORS.length).toBeGreaterThan(0)
    for (const anchor of TOUR_ONLY_ANCHORS) {
      expect(
        getHelpTopic(anchor.replace('#', '')),
        `${anchor} should not be a help topic`,
      ).toBeUndefined()
    }
  })

  it('gives every topic a title and a body', () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      expect(topic.title, `${id} title`).toBeTruthy()
      expect(topic.body, `${id} body`).toBeTruthy()
    }
  })

  it('does not resolve inherited Object properties as topics', () => {
    expect(getHelpTopic('constructor')).toBeUndefined()
    expect(getHelpTopic('toString')).toBeUndefined()
  })
})

// `resolveHelpTarget` only reads `id`, `getAttribute` and `parentElement`, so a
// minimal stand-in keeps it covered under vitest's `node` environment. The repo
// ships no DOM test environment and adding one would rewrite the whole lockfile,
// which npm re-resolves from scratch on any install.
type Attrs = Record<string, string>

type StubElement = {
  id: string
  parentElement: StubElement | null
  getAttribute: (name: string) => string | null
  __isStubElement: true
}

function makeElement(attrs: Attrs = {}): StubElement {
  const { id = '', ...rest } = attrs
  return {
    id,
    parentElement: null,
    getAttribute: (name) => rest[name] ?? null,
    __isStubElement: true,
  }
}

/** Stands in for the DOM constructor so the `instanceof HTMLElement` guard passes. */
const HTMLElementStub = {
  [Symbol.hasInstance]: (value: unknown) =>
    typeof value === 'object' && value !== null && '__isStubElement' in value,
}

const documentBody = makeElement({ id: 'stub-body' })

/** The stub replaces `globalThis.HTMLElement`, so it is a valid target at runtime. */
function target(el: StubElement): EventTarget {
  return el as unknown as EventTarget
}

/** Builds an outermost-to-innermost chain under `document.body`, returning the leaf. */
function chain(...levels: Attrs[]): StubElement {
  const nodes = levels.map(makeElement)
  nodes.forEach((node, i) => {
    node.parentElement = i === 0 ? documentBody : nodes[i - 1]
  })
  return nodes[nodes.length - 1]
}

beforeAll(() => {
  Object.assign(globalThis, { HTMLElement: HTMLElementStub, document: { body: documentBody } })
})

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'HTMLElement')
  Reflect.deleteProperty(globalThis, 'document')
})

describe('resolveHelpTarget', () => {
  it('resolves a static topic from an element id', () => {
    expect(resolveHelpTarget(target(chain({ id: 'send-button' })))).toMatchObject({
      kind: 'static',
      topicId: 'send-button',
    })
  })

  it('walks up to the nearest annotated ancestor', () => {
    const resolved = resolveHelpTarget(target(chain({ id: 'mode-buttons' }, {}, { id: 'leaf' })))
    expect(resolved).toMatchObject({ kind: 'static', topicId: 'mode-buttons' })
    expect((resolved as unknown as { element: StubElement }).element.id).toBe('mode-buttons')
  })

  it('prefers data-aipg-help over the element id', () => {
    const el = chain({ id: 'send-button', 'data-aipg-help': 'prompt-input' })
    expect(resolveHelpTarget(target(el))).toMatchObject({
      kind: 'static',
      topicId: 'prompt-input',
    })
  })

  it('resolves a preset tile to its preset name', () => {
    const thumb = chain({ 'data-aipg-preset-name': 'Line Art' }, { id: 'thumb' })
    expect(resolveHelpTarget(target(thumb))).toMatchObject({
      kind: 'preset',
      presetName: 'Line Art',
    })
  })

  it('resolves a variant tile using the internal variant name', () => {
    const label = chain(
      { 'data-aipg-preset-name': 'Line Art', 'data-aipg-variant-name': 'ov-fast' },
      { id: 'label' },
    )
    expect(resolveHelpTarget(target(label))).toMatchObject({
      kind: 'preset-variant',
      presetName: 'Line Art',
      variantName: 'ov-fast',
    })
  })

  it('prefers the innermost preset annotation over an enclosing static topic', () => {
    const tile = chain(
      { 'data-aipg-help': 'preset-selector' },
      { 'data-aipg-preset-name': 'Line Art' },
    )
    expect(resolveHelpTarget(target(tile))).toMatchObject({
      kind: 'preset',
      presetName: 'Line Art',
    })
  })

  it('prefers the preset annotation when one element carries both', () => {
    const both = chain({ 'data-aipg-help': 'preset-selector', 'data-aipg-preset-name': 'Line Art' })
    expect(resolveHelpTarget(target(both))).toMatchObject({
      kind: 'preset',
      presetName: 'Line Art',
    })
  })

  it('falls back to the enclosing static topic outside a preset tile', () => {
    const row = chain({ 'data-aipg-help': 'preset-selector' })
    expect(resolveHelpTarget(target(row))).toMatchObject({
      kind: 'static',
      topicId: 'preset-selector',
    })
  })

  it('never explains help mode itself', () => {
    expect(resolveHelpTarget(target(chain({ id: HELP_TOGGLE_ID })))).toBeNull()
    const gotIt = chain({ id: HELP_PANEL_ID }, { 'data-aipg-help': 'send-button' })
    expect(resolveHelpTarget(target(gotIt))).toBeNull()
  })

  it('returns null for unannotated elements and non-elements', () => {
    expect(resolveHelpTarget(target(chain({}, { id: 'plain' })))).toBeNull()
    expect(resolveHelpTarget(null)).toBeNull()
    expect(resolveHelpTarget('not an element' as unknown as EventTarget)).toBeNull()
  })
})

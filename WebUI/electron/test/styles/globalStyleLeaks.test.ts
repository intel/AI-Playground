import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Guard against global CSS leaking out of a single-file component.
//
// A Vue SFC `<style>` without `scoped` is injected into the document as-is. If its
// selectors are anchored to nothing but an element name, the rule silently restyles
// that element everywhere in the app — and because SFC styles are unlayered, they
// beat Tailwind's `utilities` layer outright, so no utility class can undo them
// locally. That is how a component with no `<ul>` of its own gave every list in the
// app `padding-left: 20px` (misaligning the saved-voice cards in the TTS settings),
// and how one table's `border-spacing` reached every other table.
//
// Rule: an unscoped block may only carry selectors anchored to a class, id or
// attribute — the things a component opts into. Bare element selectors must either
// be `scoped` or moved onto the element as utility classes.
//
// Unscoped is still legitimate: styling `document.body`, third-party DOM rendered
// outside the component (driver.js popovers), or `v-html` output that scoping can't
// reach (highlight.js). Those are all class/attribute-anchored, so they pass.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../../../src')

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(full)
    return entry.isFile() && entry.name.endsWith('.vue') ? [full] : []
  })
}

/** The unscoped `<style>` bodies of an SFC (CSS modules are scoped by construction). */
function unscopedStyleBlocks(source: string): string[] {
  const blocks: string[] = []
  const re = /<style([^>]*)>([\s\S]*?)<\/style>/g
  for (const match of source.matchAll(re)) {
    const attrs = match[1]
    if (/\bscoped\b|\bmodule\b/.test(attrs)) continue
    blocks.push(match[2])
  }
  return blocks
}

/**
 * Selectors in `css` that lead with a bare element name — `ul {`, `table td {`,
 * `button:hover {` — as opposed to `.card {`, `#id {`, `[data-x] {` or a nested
 * selector whose left-most compound is anchored.
 *
 * Deliberately a lexical scan rather than a CSS parse: it only has to be right
 * about the left-most compound of each selector in this repo's hand-written CSS.
 */
function bareElementSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: string[] = []
  // Each declaration block's prelude; skip at-rule preludes (@media, @keyframes…).
  for (const match of withoutComments.matchAll(/(^|[}])([^{}@]+)\{/g)) {
    const prelude = match[2].trim()
    if (!prelude) continue
    for (const selector of prelude.split(',')) {
      const trimmed = selector.trim()
      if (!trimmed) continue
      // Keyframe stops (`from`, `to`, `50%`) are not selectors.
      if (/^(from|to|\d+%)$/.test(trimmed)) continue
      // Only the left-most compound decides reach: `.card ul` is scoped to the card,
      // `ul` is not. A compound is anchored once it carries a class, id or attribute
      // (so `body.help-mode button` is fine, `button:hover` is not).
      const leftMost = trimmed.split(/[\s>+~]+/)[0]
      const anchored = /[.#[]/.test(leftMost)
      if (/^[a-zA-Z]/.test(leftMost) && !anchored) found.push(trimmed)
    }
  }
  return found
}

describe('global style leaks', () => {
  const files = vueFiles(srcDir)

  it('finds the single-file components', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('never anchors an unscoped SFC rule on a bare element selector', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      for (const block of unscopedStyleBlocks(source)) {
        for (const selector of bareElementSelectors(block)) {
          offenders.push(`${path.relative(srcDir, file)}: "${selector}"`)
        }
      }
    }
    expect(
      offenders,
      `Unscoped <style> rules anchored on an element name leak to the whole app.\n` +
        `Add \`scoped\`, or put the styling on the element as utility classes:\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})

describe('bareElementSelectors', () => {
  it('flags element-anchored selectors', () => {
    expect(bareElementSelectors('ul { padding-left: 20px; }')).toEqual(['ul'])
    expect(bareElementSelectors('table { border-spacing: 10px; }')).toEqual(['table'])
    expect(bareElementSelectors('.a button { color: red; }')).toEqual([])
    expect(bareElementSelectors('button:hover { color: red; }')).toEqual(['button:hover'])
    expect(bareElementSelectors('.card ul, ol { margin: 0 }')).toEqual(['ol'])
  })

  it('accepts class, id and attribute anchors', () => {
    expect(bareElementSelectors('.hljs { padding-left: 2px }')).toEqual([])
    expect(bareElementSelectors('#prompt-input { color: red }')).toEqual([])
    expect(bareElementSelectors('[data-tooltip]:hover::after { content: "" }')).toEqual([])
    expect(bareElementSelectors('body.help-mode button { cursor: help }')).toEqual([])
  })

  it('ignores comments and keyframe stops', () => {
    expect(bareElementSelectors('/* ul { padding: 0 } */ .a { color: red }')).toEqual([])
    expect(
      bareElementSelectors('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }'),
    ).toEqual([])
  })
})

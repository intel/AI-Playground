import { describe, expect, it } from 'vitest'
import {
  formatProbeReport,
  injectProbe,
  PROBE_PATH,
  PROBE_SCRIPT,
  type ProbeReport,
} from '../../agentMode/previewProbe.ts'

const TAG = `<script src="${PROBE_PATH}"></script>`

describe('injectProbe', () => {
  it('installs the probe before the page runs its own scripts', () => {
    const page = injectProbe('<html><head><title>Game</title></head><body></body></html>')

    expect(page.indexOf(TAG)).toBeLessThan(page.indexOf('<title>'))
  })

  it('copes with a page that has no head', () => {
    expect(injectProbe('<html><body><canvas></canvas></body></html>')).toContain(TAG)
    expect(injectProbe('<canvas></canvas>')).toContain(TAG)
  })

  it('injects exactly once, however the page is served again', () => {
    const once = injectProbe('<html><head></head></html>')

    expect(injectProbe(once)).toBe(once)
    expect(once.split(TAG)).toHaveLength(2)
  })

  it('keeps the page it was given', () => {
    const original = '<!doctype html>\n<html><head></head><body>hi</body></html>'

    expect(injectProbe(original).replace(`\n${TAG}`, '')).toBe(original)
  })
})

describe('the probe script', () => {
  // It is a string until a page evaluates it, so nothing else would catch a
  // typo in it before the agent's first play-test fails.
  it('is valid JavaScript', () => {
    expect(() => new Function(PROBE_SCRIPT)).not.toThrow()
  })

  it('installs itself only once per page', () => {
    expect(PROBE_SCRIPT).toContain('if (window.__aipgProbe) return')
  })
})

const HEALTHY: ProbeReport = {
  installed: true,
  title: 'Space Dodger',
  frames: 31,
  seconds: 0.5,
  canvas: { count: 1, width: 1280, height: 800, ink: 0.12 },
  listeners: ['keydown', 'keyup', 'pointerdown', 'resize'],
  keys: [{ key: 'ArrowLeft', delta: 0.031 }],
  game: { state: 'playing', score: 42, entities: 7 },
  errors: [],
  errorCount: 0,
}

describe('formatProbeReport', () => {
  it('reports a working game as working', () => {
    const text = formatProbeReport(HEALTHY)

    expect(text).toContain('Errors: none')
    expect(text).toContain('31 frames in 0.5s (~62 fps)')
    expect(text).toContain('1280x800, 12.0% of pixels drawn on')
    expect(text).toContain('Input listeners: keydown, keyup, pointerdown')
    expect(text).toContain('Game hook: state=playing score=42 entities=7')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  it('leaves out the resize listener, which says nothing about playability', () => {
    expect(formatProbeReport(HEALTHY)).not.toContain('resize')
  })

  // The verdict names one thing to fix, and the order matters: an exception
  // explains a frozen loop, and a frozen loop explains a blank canvas, so
  // reporting the symptom first sends the model after the wrong bug.
  it('puts an exception ahead of everything it caused', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      frames: 0,
      canvas: { count: 1, width: 1280, height: 800, ink: 0 },
      errors: ['TypeError: ship is undefined'],
      errorCount: 1,
    })

    expect(text).toContain('TypeError: ship is undefined')
    expect(text).toContain('Verdict: the page is throwing.')
  })

  it('calls out a loop that never ticked', () => {
    const text = formatProbeReport({ ...HEALTHY, frames: 0 })

    expect(text).toContain('no frames in 0.5s')
    expect(text).toContain('Verdict: nothing is animating.')
  })

  it('calls out a page that draws nothing', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      canvas: { count: 1, width: 1280, height: 800, ink: 0 },
    })

    expect(text).toContain('Verdict: the canvas is effectively blank.')
  })

  it('calls out a game nobody can play', () => {
    const text = formatProbeReport({ ...HEALTHY, listeners: ['resize'] })

    expect(text).toContain('Input listeners: none')
    expect(text).toContain('Verdict: nothing listens for the keyboard.')
  })

  it('does not fault a game for skipping the optional hook', () => {
    const text = formatProbeReport({ ...HEALTHY, game: null })

    expect(text).toContain('window.__game is not defined')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  it('says how to get a probe when the page was opened around the preview server', () => {
    expect(formatProbeReport({ installed: false })).toContain('preview server')
  })

  // WebGL pixels cannot be read back, and a game is not blank just because the
  // probe could not look.
  it('does not call an unreadable canvas blank', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      canvas: { count: 1, width: 1280, height: 800, ink: null },
    })

    expect(text).toContain('pixels unreadable')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })
})

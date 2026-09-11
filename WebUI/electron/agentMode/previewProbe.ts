// ── The play-test probe ──────────────────────────────────────────────────────
//
// What "is this game working?" costs, in tokens and in risk, depends entirely on
// how the question is asked. Screenshot-and-look costs an image decode per check
// (the loop that preceded every ErrorDeviceLost crash in the 35B benchmark runs)
// and asks a mid-size model to judge a picture, which it is bad at. This asks the
// page instead, and gets back a dozen lines of text: did anything throw, is the
// animation loop ticking, is the canvas actually drawn on, does the page listen
// for input and react to it.
//
// The script is injected by the workspace preview server, not written into the
// game, so it cannot be deleted or broken by an edit, it runs before the game's
// own code (catching the first-frame exception behind a blank page), and the
// file the user plays and shares stays exactly what the model wrote.
//
// `window.__game` is the optional half: the scaffold defines it, and a game that
// keeps it up to date gets its score and state reported too. Without it the
// generic checks still work.

export const PROBE_PATH = '/__aipg-probe.js'

const FRAME_SAMPLE_MS = 500
const KEY_HOLD_MS = 250

export const PROBE_SCRIPT = `(function () {
  if (window.__aipgProbe) return
  var errors = []
  var frames = 0
  var listeners = Object.create(null)

  function note(message) {
    if (errors.length < 20) errors.push(String(message))
  }
  // Registered before addEventListener is patched, so the probe never counts
  // itself among the page's own listeners.
  window.addEventListener('error', function (event) {
    note((event.error && event.error.stack) || event.message || 'Uncaught error')
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    note('Unhandled rejection: ' + ((reason && reason.stack) || reason))
  })

  var rawAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type) {
    listeners[type] = (listeners[type] || 0) + 1
    return rawAdd.apply(this, arguments)
  }

  // Counting callbacks rather than trusting the game to report: a loop that
  // never started and one that threw on frame 3 both show up as zero.
  var rawRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = function (callback) {
    return rawRaf(function (time) {
      frames++
      return callback(time)
    })
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function biggestCanvas() {
    var all = document.querySelectorAll('canvas')
    var best = null
    for (var i = 0; i < all.length; i++) {
      if (!best || all[i].width * all[i].height > best.width * best.height) best = all[i]
    }
    return best
  }

  // Read back through a copy rather than from the game's own context: reading
  // from a canvas that was not created for it makes Chrome log a
  // willReadFrequently warning, and console noise the agent did not cause is
  // console noise it will try to fix.
  var scratch = null
  function readPixels(canvas) {
    if (!scratch) {
      scratch = document.createElement('canvas')
      scratch.__ctx = scratch.getContext('2d', { willReadFrequently: true })
    }
    if (!scratch.__ctx) return null
    scratch.width = canvas.width
    scratch.height = canvas.height
    scratch.__ctx.drawImage(canvas, 0, 0)
    return scratch.__ctx.getImageData(0, 0, canvas.width, canvas.height).data
  }

  /** Pixels on a grid, as one flat array of r,g,b,a. */
  function samplePixels(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null
    var context
    try {
      // Only a type check: a canvas driven by WebGL answers null here, and its
      // pixels are gone by the time anything could copy them.
      context = canvas.getContext('2d')
    } catch (error) {
      return null
    }
    if (!context) return null
    var data
    try {
      data = readPixels(canvas)
    } catch (error) {
      return null
    }
    if (!data) return null
    // Fine enough that one sprite on a full-window canvas registers: at 48
    // samples across, a 32px ship read as 0.08% of the picture and the verdict
    // called a working game blank.
    var step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 160))
    var out = []
    for (var y = 0; y < canvas.height; y += step) {
      for (var x = 0; x < canvas.width; x += step) {
        var at = (y * canvas.width + x) * 4
        out.push(data[at], data[at + 1], data[at + 2], data[at + 3])
      }
    }
    return out
  }

  /** Share of sampled pixels that differ from the most common colour. */
  function inkRatio(pixels) {
    if (!pixels || pixels.length === 0) return null
    var counts = Object.create(null)
    var keys = []
    var total = 0
    for (var i = 0; i < pixels.length; i += 4) {
      var key = pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2] + ',' + pixels[i + 3]
      if (counts[key] === undefined) {
        counts[key] = 0
        keys.push(key)
      }
      counts[key]++
      total++
    }
    var top = 0
    for (var k = 0; k < keys.length; k++) if (counts[keys[k]] > top) top = counts[keys[k]]
    return total === 0 ? null : (total - top) / total
  }

  function pixelDelta(before, after) {
    if (!before || !after || before.length !== after.length || before.length === 0) return null
    var changed = 0
    for (var i = 0; i < before.length; i += 4) {
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2]
      ) {
        changed++
      }
    }
    return changed / (before.length / 4)
  }

  var KEY_CODES = {
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ' ': 'Space',
    Enter: 'Enter',
  }

  function keyEvent(type, key) {
    return new KeyboardEvent(type, {
      key: key,
      code: KEY_CODES[key] || 'Key' + key.toUpperCase(),
      bubbles: true,
      cancelable: true,
    })
  }

  // Dispatched on the canvas when there is one: the event then bubbles through
  // document to window, so a listener on any of the three sees it.
  function inputTarget() {
    return biggestCanvas() || document.body || document
  }

  function readGameHook() {
    if (!window.__game || typeof window.__game !== 'object') return null
    var out = {}
    var found = false
    var fields = ['state', 'score', 'entities', 'lives', 'level']
    for (var i = 0; i < fields.length; i++) {
      try {
        var value = window.__game[fields[i]]
        if (value === undefined || typeof value === 'function') continue
        out[fields[i]] = typeof value === 'object' ? JSON.stringify(value) : value
        found = true
      } catch (error) {
        out[fields[i]] = 'threw: ' + error
        found = true
      }
    }
    return found ? out : null
  }

  window.__aipgProbe = async function (options) {
    var keys = (options && options.keys) || ['ArrowLeft', ' ']
    var startFrames = frames
    await wait(${FRAME_SAMPLE_MS})
    var canvas = biggestCanvas()
    var pixels = samplePixels(canvas)
    var report = {
      installed: true,
      title: document.title,
      url: location.pathname,
      frames: frames - startFrames,
      seconds: ${FRAME_SAMPLE_MS} / 1000,
      canvas: canvas
        ? {
            count: document.querySelectorAll('canvas').length,
            width: canvas.width,
            height: canvas.height,
            ink: inkRatio(pixels),
          }
        : null,
      listeners: Object.keys(listeners),
      keys: [],
      game: readGameHook(),
      errors: errors.slice(0, 5),
      errorCount: errors.length,
    }
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      var before = samplePixels(canvas)
      var target = inputTarget()
      target.dispatchEvent(keyEvent('keydown', key))
      await wait(${KEY_HOLD_MS})
      var after = samplePixels(canvas)
      target.dispatchEvent(keyEvent('keyup', key))
      report.keys.push({ key: key, delta: pixelDelta(before, after) })
    }
    report.errorCount = errors.length
    report.errors = errors.slice(0, 5)
    return report
  }
})()
`

/** Evaluated in the page by the browser tool's `probe` action. */
export const PROBE_CALL = `
  if (!window.__aipgProbe) return { installed: false }
  return await window.__aipgProbe({})
`

export type ProbeReport = {
  installed: boolean
  title?: string
  url?: string
  frames?: number
  seconds?: number
  canvas?: { count: number; width: number; height: number; ink: number | null } | null
  listeners?: string[]
  keys?: { key: string; delta: number | null }[]
  game?: Record<string, string | number> | null
  errors?: string[]
  errorCount?: number
}

// A page that draws nothing reads as exactly one colour. The margin above zero
// only covers a stray pixel or two; a game whose whole scene is one small sprite
// is legitimately down here, so this deliberately does not ask for much.
export const MIN_INK = 0.0002

/**
 * Inject the probe into a page the preview server is about to serve. Idempotent
 * (a page that already carries the tag is left alone) and placed as early as the
 * document allows, so it is installed before the game's own scripts run.
 */
export function injectProbe(html: string): string {
  if (html.includes(PROBE_PATH)) return html
  const tag = `<script src="${PROBE_PATH}"></script>`
  const head = html.match(/<head[^>]*>/i)
  if (head?.index !== undefined) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`
  }
  const openingHtml = html.match(/<html[^>]*>/i)
  if (openingHtml?.index !== undefined) {
    const at = openingHtml.index + openingHtml[0].length
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`
  }
  return `${tag}\n${html}`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * The report as the model reads it: the findings first, then one verdict line
 * naming the single thing to fix next. Ordered by what blocks what — an
 * exception explains a frozen loop, and a frozen loop explains a blank canvas,
 * so chasing them in the other order wastes turns.
 */
export function formatProbeReport(report: ProbeReport): string {
  if (!report?.installed) {
    return (
      'No play-test probe on this page. Open it through the workspace preview server ' +
      '(pass just the file name, e.g. "index.html") rather than an outside URL, then probe again.'
    )
  }
  const lines: string[] = []
  const errorCount = report.errorCount ?? 0
  lines.push(
    errorCount === 0
      ? 'Errors: none'
      : `Errors: ${errorCount}\n  ${(report.errors ?? []).join('\n  ')}`,
  )

  const frames = report.frames ?? 0
  const seconds = report.seconds || 1
  lines.push(
    frames === 0
      ? `Animation: no frames in ${seconds}s — nothing is calling requestAnimationFrame`
      : `Animation: ${frames} frames in ${seconds}s (~${Math.round(frames / seconds)} fps)`,
  )

  const canvas = report.canvas
  if (!canvas) {
    lines.push('Canvas: none on the page')
  } else {
    const ink = canvas.ink
    lines.push(
      `Canvas: ${canvas.width}x${canvas.height}` +
        (canvas.count > 1 ? ` (${canvas.count} on the page)` : '') +
        (ink === null ? ', pixels unreadable (WebGL?)' : `, ${percent(ink)} of pixels drawn on`),
    )
  }

  const listeners = report.listeners ?? []
  const inputListeners = listeners.filter((type) => /^(key|pointer|mouse|touch|click)/.test(type))
  lines.push(
    inputListeners.length > 0
      ? `Input listeners: ${inputListeners.join(', ')}`
      : 'Input listeners: none — the page cannot be played',
  )

  for (const key of report.keys ?? []) {
    const label = key.key === ' ' ? 'Space' : key.key
    lines.push(
      key.delta === null
        ? `Pressed ${label}: could not compare pixels`
        : `Pressed ${label}: ${percent(key.delta)} of pixels changed`,
    )
  }

  if (report.game) {
    const fields = Object.entries(report.game)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ')
    lines.push(`Game hook: ${fields}`)
  } else {
    lines.push('Game hook: window.__game is not defined (state checks unavailable)')
  }

  lines.push(`Verdict: ${verdict(report)}`)
  return lines.join('\n')
}

function verdict(report: ProbeReport): string {
  if ((report.errorCount ?? 0) > 0) {
    return 'the page is throwing. Fix the errors above before anything else.'
  }
  if ((report.frames ?? 0) === 0) {
    return 'nothing is animating. Check that the loop starts and calls requestAnimationFrame again.'
  }
  const ink = report.canvas?.ink
  if (report.canvas && ink !== null && ink !== undefined && ink < MIN_INK) {
    return 'the canvas is effectively blank. Check that draw() runs and uses canvas.width/height.'
  }
  const hasKeyboard = (report.listeners ?? []).some((type) => type.startsWith('key'))
  if (!hasKeyboard) {
    return 'nothing listens for the keyboard. Add key handling before calling the game playable.'
  }
  return 'running, drawing and listening for input.'
}

import fs from 'node:fs'
import path from 'node:path'

// ── The starting point every game is built from ──────────────────────────────
//
// A new game folder does not start empty: it starts with a page that already
// runs. The agent's first act is then an `edit`, not a 500-line `write` that
// competes with its own output-token budget — the failure mode that used to
// cost whole attempts, and the reason its games came out smaller than the ones
// a plain chat writes in one reply.
//
// Two files, not one. `edit` matches on unique text, and a short file gives it
// far less to be ambiguous about; the sections below are marked so a model can
// replace one whole block at a time. Splitting is only safe because both are
// loaded with a CLASSIC script tag: the finished game is opened through
// `shell.openPath` as a file:// page, where ES modules and `fetch()` of a
// sibling file are blocked, so `type="module"` would work in the agent's
// preview (served over HTTP) and break the moment the user hits Play.
//
// `window.__game` at the bottom is what the play-test probe reads
// (`browser {"action":"probe"}`); it degrades to generic checks when a game
// drops it.

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>New game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b1020; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; touch-action: none; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<!-- A classic script on purpose: this page is opened as a file:// page when the
     user plays it, and there ES modules and fetch() of a sibling file are blocked. -->
<script src="game.js"></script>
</body>
</html>
`

const GAME_JS = `// This game already runs: a canvas, an animation loop, keyboard and pointer
// input, and one thing moving on screen. Grow it by replacing a whole section
// between the "// === name ===" markers rather than rewriting the file.

// === config ===
const CONFIG = {
  background: '#0b1020',
  accent: '#4f8cff',
  playerSpeed: 420, // pixels per second, so movement is frame-rate independent
}

// === state ===
const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')

const game = {
  phase: 'playing', // 'title' | 'playing' | 'gameover'
  score: 0,
  time: 0,
  player: { x: 0, y: 0, radius: 16 },
  entities: [], // everything else the game moves and draws
}

function resize() {
  canvas.width = canvas.clientWidth
  canvas.height = canvas.clientHeight
}

function reset() {
  game.phase = 'playing'
  game.score = 0
  game.time = 0
  game.entities = []
  game.player.x = canvas.width / 2
  game.player.y = canvas.height / 2
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

// === input ===
const keys = new Set()
const pointer = { x: 0, y: 0, active: false }
const HELD_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']

window.addEventListener('keydown', (event) => {
  keys.add(event.key)
  // Arrows and space scroll the page otherwise, which fights the game.
  if (HELD_KEYS.includes(event.key)) event.preventDefault()
})
window.addEventListener('keyup', (event) => keys.delete(event.key))

function trackPointer(event) {
  const bounds = canvas.getBoundingClientRect()
  pointer.x = event.clientX - bounds.left
  pointer.y = event.clientY - bounds.top
}

canvas.addEventListener('pointerdown', (event) => {
  pointer.active = true
  trackPointer(event)
})
canvas.addEventListener('pointermove', trackPointer)
window.addEventListener('pointerup', () => {
  pointer.active = false
})

// === update ===
function update(dt) {
  game.time += dt
  const step = CONFIG.playerSpeed * dt
  if (keys.has('ArrowLeft') || keys.has('a')) game.player.x -= step
  if (keys.has('ArrowRight') || keys.has('d')) game.player.x += step
  if (keys.has('ArrowUp') || keys.has('w')) game.player.y -= step
  if (keys.has('ArrowDown') || keys.has('s')) game.player.y += step
  // Touch and mouse: drift towards where the finger is, so it plays on a laptop
  // and on a touchscreen without a second control scheme.
  if (pointer.active) {
    const follow = Math.min(1, dt * 8)
    game.player.x += (pointer.x - game.player.x) * follow
    game.player.y += (pointer.y - game.player.y) * follow
  }
  const edge = game.player.radius
  game.player.x = clamp(game.player.x, edge, canvas.width - edge)
  game.player.y = clamp(game.player.y, edge, canvas.height - edge)
  game.score = Math.floor(game.time * 10)
}

// === draw ===
function draw() {
  ctx.fillStyle = CONFIG.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = CONFIG.accent
  ctx.beginPath()
  ctx.arc(game.player.x, game.player.y, game.player.radius, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#f2f4f8'
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText('Score ' + game.score, 16, 28)
}

// === loop ===
let lastFrame = performance.now()

function frame(now) {
  // Clamped at both ends: a hidden tab hands back a dt of several seconds, which
  // teleports everything through everything else on the first frame back, and
  // the first frame's timestamp can predate this script, giving a negative one.
  const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.05)
  lastFrame = now
  if (game.phase === 'playing') update(dt)
  draw()
  requestAnimationFrame(frame)
}

window.addEventListener('resize', resize)
resize()
reset()
requestAnimationFrame(frame)

// === debug hook ===
// Read by the app when it play-tests this game. Keep these pointing at the real
// state as the game grows; nothing the player sees depends on them.
window.__game = {
  get state() {
    return game.phase
  },
  get score() {
    return game.score
  },
  get entities() {
    return game.entities.length
  },
  reset,
}
`

/** The section markers `edit` calls are expected to aim at. */
export const SCAFFOLD_ANCHORS = [
  '// === config ===',
  '// === state ===',
  '// === input ===',
  '// === update ===',
  '// === draw ===',
  '// === loop ===',
  '// === debug hook ===',
] as const

export const SCAFFOLD_FILES: Record<string, string> = {
  'index.html': INDEX_HTML,
  'game.js': GAME_JS,
}

/**
 * Put the starting game into a folder. Never overwrites: a folder that already
 * holds an `index.html` is a game someone worked on, and replacing it with the
 * skeleton would throw that work away.
 */
export function writeScaffold(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(SCAFFOLD_FILES)) {
    const target = path.join(dir, name)
    if (fs.existsSync(target)) continue
    fs.writeFileSync(target, contents, 'utf-8')
  }
}

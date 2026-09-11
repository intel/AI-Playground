import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// gameLibrary reaches Electron only through util.ts's lazy getGamesDir(); every
// call here passes an explicit root, so the mock just keeps the import graph quiet.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

const {
  arcadeCatalog,
  createGame,
  listGames,
  provisionalName,
  publishGame,
  readGame,
  setArcadeShown,
  setGameIcon,
  slugify,
  updateGame,
  writeArcade,
} = await import('../gameLibrary.ts')
const { SCAFFOLD_ANCHORS } = await import('../gameScaffold.ts')

let root: string
/** Stand-in for the samples the app ships, so no test reads WebUI/external. */
let bundle: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-games-'))
  bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-samples-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(bundle, { recursive: true, force: true })
})

/** A bundle holding `slugs` as playable, published sample games, in that order. */
function writeSampleBundle(slugs: string[]): void {
  for (const slug of slugs) {
    const folder = path.join(bundle, slug)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(
      path.join(folder, 'game.json'),
      JSON.stringify({
        id: slug,
        name: `Sample ${slug}`,
        description: 'One of the games we ship.',
        entry: 'index.html',
        icon: 'icon.png',
        published: true,
        createdAt: 1,
        updatedAt: 2,
        backend: 'cloud',
        startingModel: 'Grok 4.5',
        initialPrompt: 'make me a sample',
      }),
    )
    fs.writeFileSync(path.join(folder, 'index.html'), '<html></html>')
    fs.writeFileSync(path.join(folder, 'icon.png'), 'not really a png')
  }
  fs.writeFileSync(path.join(bundle, 'samples.json'), JSON.stringify({ games: slugs }))
}

/** The manifest the gallery page carries, as the page's own script reads it. */
function inlinedManifest(): Array<Record<string, unknown>> {
  const arcade = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
  const inlined = arcade.match(/<script type="application\/json" id="library">(.*?)<\/script>/s)
  expect(inlined, 'gallery carries no inlined manifest').not.toBeNull()
  return JSON.parse(inlined![1])
}

describe('slugify', () => {
  it('turns a request into a readable folder name', () => {
    expect(slugify('Space Dodger')).toBe('space-dodger')
    expect(slugify('  A one-button, endless RUNNER!  ')).toBe('a-one-button-endless-runner')
  })

  it('falls back to a generic name when nothing survives', () => {
    expect(slugify('🎮🎮')).toBe('game')
    expect(slugify('')).toBe('game')
  })

  it('stays short enough to read in a file dialog', () => {
    expect(slugify('a'.repeat(120)).length).toBeLessThanOrEqual(40)
  })

  it('cuts between words, since the name is often a whole sentence', () => {
    // The first turn's prompt is the name, so a naive cut leaves half a word.
    expect(slugify('a one-button endless runner where I dodge asteroids')).toBe(
      'a-one-button-endless-runner-where-i',
    )
  })
})

describe('provisionalName', () => {
  it('shortens the request into something that reads as a title', () => {
    expect(provisionalName('a one-button endless runner where I dodge asteroids')).toBe(
      'a one-button endless runner where I…',
    )
  })

  it('leaves a short request alone', () => {
    expect(provisionalName('  space dodger  ')).toBe('space dodger')
  })

  it('falls back when there is nothing to shorten', () => {
    expect(provisionalName('   ')).toBe('New game')
  })
})

describe('createGame', () => {
  it('writes a draft card into a folder named after the request', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    expect(path.basename(game.dir)).toBe('space-dodger')
    expect(game.id).toBe('space-dodger')
    expect(game.published).toBe(false)
    expect(game.entryPath).toBe(path.join(game.dir, 'index.html'))
    expect(JSON.parse(fs.readFileSync(path.join(game.dir, 'game.json'), 'utf-8'))).toMatchObject({
      id: 'space-dodger',
      name: 'Space Dodger',
      entry: 'index.html',
      published: false,
    })
  })

  // The agent's first act should be an `edit` against a page that already runs,
  // not a whole game in one `write` that the completion cap cuts off.
  it('leaves a game that already runs in the folder', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    const page = fs.readFileSync(path.join(game.dir, 'index.html'), 'utf-8')
    const script = fs.readFileSync(path.join(game.dir, 'game.js'), 'utf-8')

    expect(page).toContain('<canvas id="game">')
    expect(script).toContain('requestAnimationFrame(frame)')
    expect(script).toContain('window.__game')
  })

  // The one-shot preset writes the whole game itself, so a page it did not write
  // would be something to work around rather than something to build on.
  it('leaves the folder empty when the preset writes the game whole', () => {
    const game = createGame({ name: 'Space Dodger', scaffold: false }, root)
    expect(fs.readdirSync(game.dir)).toEqual(['game.json'])
    // Still the file Play opens; it just does not exist until the agent writes it.
    expect(game.entryPath).toBe(path.join(game.dir, 'index.html'))
  })

  it('marks every section the agent is told to edit against', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    const script = fs.readFileSync(path.join(game.dir, 'game.js'), 'utf-8')

    for (const anchor of SCAFFOLD_ANCHORS) {
      expect(script.split(anchor), `${anchor} is not a unique edit target`).toHaveLength(2)
    }
  })

  // Play opens the entry through shell.openPath, so the game runs as a file://
  // page — where a module script and fetch() of a sibling file are blocked. Both
  // work in the agent's HTTP preview, so this only breaks for the user.
  it('loads its second file the way a file:// page can', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    const page = fs.readFileSync(path.join(game.dir, 'index.html'), 'utf-8')

    expect(page).toContain('<script src="game.js"></script>')
    expect(page).not.toContain('type="module"')
  })

  it('records what the game was started on, prompt included', () => {
    const game = createGame(
      {
        name: 'a one-button endless runner…',
        backend: 'llamaCPP',
        startingModel: 'Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf',
        initialPrompt: 'a one-button endless runner where I dodge asteroids',
      },
      root,
    )
    expect(readGame(game.dir)).toMatchObject({
      backend: 'llamaCPP',
      startingModel: 'Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf',
      // The whole request, not the shortening that became the name.
      initialPrompt: 'a one-button endless runner where I dodge asteroids',
    })
  })

  it('leaves out provenance nobody supplied', () => {
    const game = createGame({ name: 'Space Dodger', startingModel: '  ' }, root)
    const card = JSON.parse(fs.readFileSync(path.join(game.dir, 'game.json'), 'utf-8'))
    expect(Object.keys(card)).not.toContain('backend')
    expect(Object.keys(card)).not.toContain('startingModel')
  })

  it('gives a second game of the same name its own folder', () => {
    const first = createGame({ name: 'Space Dodger' }, root)
    const second = createGame({ name: 'Space Dodger' }, root)
    expect(second.dir).not.toBe(first.dir)
    expect(path.basename(second.dir)).toMatch(/^space-dodger-[0-9a-f]{4}$/)
    expect(fs.existsSync(path.join(first.dir, 'game.json'))).toBe(true)
  })
})

describe('readGame', () => {
  it('reports a folder that is not a game', () => {
    fs.mkdirSync(path.join(root, 'not-a-game'))
    expect(readGame(path.join(root, 'not-a-game'))).toBeNull()
  })

  // Games made before provenance was recorded, and folders copied in by hand.
  it('reads a card that carries no provenance', () => {
    const dir = path.join(root, 'older-game')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ id: 'older-game', name: 'Old' }))
    expect(readGame(dir)).toMatchObject({ id: 'older-game', name: 'Old' })
    expect(readGame(dir)?.initialPrompt).toBeUndefined()
  })

  it('reports a card it cannot parse rather than throwing', () => {
    const dir = path.join(root, 'broken')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'game.json'), '{ not json')
    expect(readGame(dir)).toBeNull()
  })
})

describe('updateGame', () => {
  it('keeps fields it was not told about and bumps updatedAt', () => {
    const game = createGame({ name: 'Draft' }, root)
    const updated = updateGame(game.dir, { name: 'Space Dodger' })
    expect(updated.name).toBe('Space Dodger')
    expect(updated.entry).toBe(game.entry)
    expect(updated.createdAt).toBe(game.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(game.updatedAt)
  })

  it('refuses a folder without a card', () => {
    expect(() => updateGame(path.join(root, 'nope'), { name: 'x' })).toThrow(/Not a game folder/)
  })
})

describe('setGameIcon', () => {
  it('adopts generated art as the cover', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    fs.mkdirSync(path.join(game.dir, 'generated'))
    fs.writeFileSync(path.join(game.dir, 'generated', 'AIPG_00001_.png'), 'png')
    const updated = setGameIcon(game.dir, 'generated/AIPG_00001_.png')
    expect(updated.icon).toBe('icon.png')
    // Copied, so cleaning up `generated/` cannot take the icon with it.
    expect(fs.readFileSync(path.join(game.dir, 'icon.png'), 'utf-8')).toBe('png')
    expect(updated.iconPath).toBe(path.join(game.dir, 'icon.png'))
  })

  // The app window cannot load a `file://` image, so the card carries a URL on
  // the scheme that serves the library (see aipgMediaRoots in main.ts).
  it('offers the cover as a URL the app window can load', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    fs.writeFileSync(path.join(game.dir, 'cover art.png'), 'png')
    expect(setGameIcon(game.dir, 'cover art.png').iconUrl).toBe(
      'aipg-media://games/space-dodger/icon.png',
    )
  })

  it('offers no cover URL until there is a cover', () => {
    expect(createGame({ name: 'Space Dodger' }, root).iconUrl).toBeUndefined()
  })

  it('rejects a path outside the game folder', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    fs.writeFileSync(path.join(root, 'elsewhere.png'), 'png')
    expect(() => setGameIcon(game.dir, '../elsewhere.png')).toThrow(/inside the game folder/)
  })

  it('rejects an icon that does not exist', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    expect(() => setGameIcon(game.dir, 'generated/missing.png')).toThrow(/does not exist/)
  })
})

describe('listGames', () => {
  it('finds games by their cards, ignoring anything else in the folder', () => {
    const first = createGame({ name: 'First' }, root)
    createGame({ name: 'Second' }, root)
    fs.mkdirSync(path.join(root, 'stray-folder'))
    fs.writeFileSync(path.join(root, 'library.json'), '{}')
    updateGame(first.dir, { description: 'touched last' })

    const games = listGames(root)
    expect(games.map((game) => game.id)).toEqual(['first', 'second'])
    expect(games[0].description).toBe('touched last')
  })

  it('is empty for a library that does not exist yet', () => {
    expect(listGames(path.join(root, 'missing'))).toEqual([])
  })
})

describe('publishGame and writeArcade', () => {
  it('saves the confirmed name and description into the library', () => {
    const game = createGame({ name: 'draft name' }, root)
    const published = publishGame(
      game.dir,
      { name: 'Space Dodger', description: 'Dodge asteroids.' },
      { root },
    )
    expect(published).toMatchObject({
      published: true,
      name: 'Space Dodger',
      description: 'Dodge asteroids.',
    })
  })

  it('inlines the manifest into a gallery that works without the app', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    fs.writeFileSync(path.join(game.dir, 'index.html'), '<html></html>')
    publishGame(game.dir, { description: 'Dodge asteroids.' }, { root })

    const arcade = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    const inlined = arcade.match(/<script type="application\/json" id="library">(.*?)<\/script>/s)
    expect(inlined, 'gallery carries no inlined manifest').not.toBeNull()
    expect(JSON.parse(inlined![1])).toEqual([
      {
        id: 'space-dodger',
        name: 'Space Dodger',
        description: 'Dodge asteroids.',
        entry: 'space-dodger/index.html',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ])
    // No fetch of a sibling file, which a file:// page would be refused.
    expect(arcade).not.toMatch(/fetch\(/)
  })

  // Naming a game says nothing about how it was made, so publishing must leave
  // the provenance the first turn recorded alone.
  it('keeps provenance when the user names the game', () => {
    const game = createGame(
      { name: 'draft name', backend: 'openVINO', startingModel: 'OpenVINO/gpt-oss-20b-int4-ov' },
      root,
    )
    const published = publishGame(game.dir, { name: 'Space Dodger' }, { root })
    expect(published).toMatchObject({
      name: 'Space Dodger',
      backend: 'openVINO',
      startingModel: 'OpenVINO/gpt-oss-20b-int4-ov',
    })
  })

  it('carries provenance into the gallery, with the button that shows it', () => {
    const game = createGame(
      {
        name: 'Space Dodger',
        backend: 'llamaCPP',
        startingModel: 'Qwen3.8-27B-Q4_K_M.gguf',
        initialPrompt: 'a one-button endless runner where I dodge asteroids',
      },
      root,
    )
    publishGame(game.dir, {}, { root })

    const arcade = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    const inlined = arcade.match(/<script type="application\/json" id="library">(.*?)<\/script>/s)
    expect(JSON.parse(inlined![1])[0]).toMatchObject({
      backend: 'llamaCPP',
      startingModel: 'Qwen3.8-27B-Q4_K_M.gguf',
      initialPrompt: 'a one-button endless runner where I dodge asteroids',
    })
    expect(arcade).toContain('Generation info')
  })

  it('escapes a prompt so it cannot break out of the page', () => {
    const game = createGame(
      { name: 'Space Dodger', initialPrompt: 'make me </script><img src=x onerror=alert(1)>' },
      root,
    )
    publishGame(game.dir, {}, { root })
    const arcade = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    expect(arcade).not.toContain('<img src=x')
  })

  it('writes library.json as the stable input for uploading a library', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    publishGame(game.dir, {}, { root, vendor: 'acer', samplesRoot: null })
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf-8'))
    expect(manifest).toMatchObject({ vendor: 'acer' })
    expect(manifest.games).toHaveLength(1)
  })

  it('shows only games the user saved', () => {
    const saved = createGame({ name: 'Saved' }, root)
    createGame({ name: 'Draft' }, root)
    publishGame(saved.dir, {}, { root })

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf-8'))
    expect(manifest.games.map((entry: { id: string }) => entry.id)).toEqual(['saved'])
  })

  it('brands the gallery for Acer only when the machine is one', () => {
    createGame({ name: 'Space Dodger' }, root)
    writeArcade({ root, vendor: 'acer', samplesRoot: null })
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf-8')).toContain('My Acer Arcade')
    writeArcade({ root, vendor: 'unknown', samplesRoot: null })
    const neutral = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    expect(neutral).not.toContain('Acer')
    expect(neutral).toContain('My Arcade')
  })

  it('escapes a game name so it cannot break out of the page', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    publishGame(game.dir, { name: '</script><img src=x onerror=alert(1)>' }, { root })
    const arcade = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    // The name is rendered via textContent from the inlined JSON, so the closing
    // tag must not survive as markup.
    expect(arcade).not.toContain('<img src=x')
  })
})

describe('the sample games shipped with the app', () => {
  it('shows them in the Acer gallery, behind the games the user made', () => {
    // Bundle order, not folder order: alphabetically 'neon-drift' would be first.
    writeSampleBundle(['pong', 'neon-drift'])
    const mine = createGame({ name: 'Mine' }, root)
    publishGame(mine.dir, {}, { root, vendor: 'acer', samplesRoot: bundle })

    const manifest = inlinedManifest()
    expect(manifest.map((entry) => entry.id)).toEqual(['mine', 'pong', 'neon-drift'])
    expect(manifest[1]).toMatchObject({
      name: 'Sample pong',
      entry: '_arcade-samples/pong/index.html',
      icon: '_arcade-samples/pong/icon.png',
    })
  })

  // The whole point of the nested folder: a sample is something to play, never a
  // draft the Game Agent session list offers to continue.
  it('copies them where the library does not look for games', () => {
    writeSampleBundle(['pong'])
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })

    expect(fs.existsSync(path.join(root, '_arcade-samples', 'pong', 'index.html'))).toBe(true)
    expect(listGames(root)).toEqual([])
  })

  it('carries the provenance that gives them an info button', () => {
    writeSampleBundle(['pong'])
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })

    expect(inlinedManifest()[0]).toMatchObject({
      backend: 'cloud',
      startingModel: 'Grok 4.5',
      initialPrompt: 'make me a sample',
    })
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf-8')).toContain('Generation info')
  })

  // The arcade is an Acer deliverable, and so are the games in it.
  it('ships none of them to a machine that is not an Acer', () => {
    writeSampleBundle(['pong'])
    writeArcade({ root, vendor: 'unknown', samplesRoot: bundle })

    expect(fs.existsSync(path.join(root, '_arcade-samples'))).toBe(false)
    expect(inlinedManifest()).toEqual([])
  })

  // library.json is the input for uploading the user's library to the portal, so
  // shipped demos in it would be uploaded as games they made.
  it('keeps them out of library.json', () => {
    writeSampleBundle(['pong'])
    const mine = createGame({ name: 'Mine' }, root)
    publishGame(mine.dir, {}, { root, vendor: 'acer', samplesRoot: bundle })

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf-8'))
    expect(manifest.games.map((entry: { id: string }) => entry.id)).toEqual(['mine'])
  })

  it('refreshes a copy the app updated', () => {
    writeSampleBundle(['pong'])
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })
    fs.writeFileSync(path.join(bundle, 'pong', 'index.html'), '<html>newer</html>')
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })

    const installed = path.join(root, '_arcade-samples', 'pong', 'index.html')
    expect(fs.readFileSync(installed, 'utf-8')).toBe('<html>newer</html>')
  })

  it('ignores a bundle entry that points outside the bundle', () => {
    writeSampleBundle(['pong'])
    fs.writeFileSync(
      path.join(bundle, 'samples.json'),
      JSON.stringify({ games: ['../../etc', 'pong'] }),
    )
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })

    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['pong'])
  })

  it('writes the gallery as usual when the app ships no samples', () => {
    const mine = createGame({ name: 'Mine' }, root)
    publishGame(mine.dir, {}, { root, vendor: 'acer', samplesRoot: path.join(bundle, 'missing') })

    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['mine'])
  })
})

// The page is regenerated on every open, so taking a game off it is a change to
// the library rather than an edit of the HTML — which is what a tester who
// deleted a card and watched it come back was running into.
describe('taking a game off the arcade page', () => {
  it('drops a game the user hid, and puts it back', () => {
    const game = createGame({ name: 'Space Dodger' }, root)
    publishGame(game.dir, {}, { root })

    setArcadeShown({ kind: 'user', id: 'space-dodger', shown: false }, { root })
    expect(inlinedManifest()).toEqual([])
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf-8')).games,
    ).toHaveLength(0)

    setArcadeShown({ kind: 'user', id: 'space-dodger', shown: true }, { root })
    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['space-dodger'])
  })

  // The bundle is recopied over the installed samples on every write, so the flag
  // cannot live in the copy's own game.json.
  it('keeps a hidden sample hidden when the app reinstalls it', () => {
    writeSampleBundle(['pong', 'neon-drift'])
    const options = { root, vendor: 'acer', samplesRoot: bundle }
    setArcadeShown({ kind: 'sample', id: 'pong', shown: false }, options)
    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['neon-drift'])

    writeArcade(options)
    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['neon-drift'])
    // Hidden from the page, still installed: showing it again needs no reinstall.
    expect(fs.existsSync(path.join(root, '_arcade-samples', 'pong', 'index.html'))).toBe(true)

    setArcadeShown({ kind: 'sample', id: 'pong', shown: true }, options)
    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['pong', 'neon-drift'])
  })

  it('leaves a hidden sample out of the upload manifest as well', () => {
    writeSampleBundle(['pong'])
    const mine = createGame({ name: 'Mine' }, root)
    publishGame(mine.dir, {}, { root, vendor: 'acer', samplesRoot: bundle })
    setArcadeShown(
      { kind: 'sample', id: 'pong', shown: false },
      { root, vendor: 'acer', samplesRoot: bundle },
    )

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf-8'))
    expect(manifest.games.map((entry: { id: string }) => entry.id)).toEqual(['mine'])
  })

  it('writes the gallery as it always did when nothing is hidden', () => {
    writeSampleBundle(['pong'])
    const mine = createGame({ name: 'Mine' }, root)
    publishGame(mine.dir, {}, { root, vendor: 'acer', samplesRoot: bundle })

    expect(fs.existsSync(path.join(root, 'arcade-hidden.json'))).toBe(false)
    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['mine', 'pong'])
  })

  it('ignores an unreadable hide list rather than losing the samples', () => {
    writeSampleBundle(['pong'])
    fs.writeFileSync(path.join(root, 'arcade-hidden.json'), 'not json')
    writeArcade({ root, vendor: 'acer', samplesRoot: bundle })

    expect(inlinedManifest().map((entry) => entry.id)).toEqual(['pong'])
  })

  it('refuses an id that points outside the library', () => {
    createGame({ name: 'Mine' }, root)
    expect(() =>
      setArcadeShown({ kind: 'user', id: '../elsewhere', shown: false }, { root }),
    ).toThrow(/Not a game in the library/)
    expect(() => setArcadeShown({ kind: 'sample', id: '../..', shown: false }, { root })).toThrow(
      /Not a sample game/,
    )
  })
})

describe('arcadeCatalog', () => {
  it('offers drafts and published games alike, with whether the page lists them', () => {
    const saved = createGame({ name: 'Saved' }, root)
    createGame({ name: 'Draft' }, root)
    publishGame(saved.dir, {}, { root })

    // Sorted by id, not taken in catalog order: listGames orders by `updatedAt`,
    // and on a fast machine every write here lands in the same millisecond — so the
    // publish does not reliably make "saved" the newer of the two. What this test is
    // about is that both games are offered and each carries its own `shown`.
    const catalog = [...arcadeCatalog({ root })].sort((a, b) => a.id.localeCompare(b.id))
    expect(catalog).toEqual([
      expect.objectContaining({ kind: 'user', id: 'draft', name: 'Draft', shown: false }),
      expect.objectContaining({ kind: 'user', id: 'saved', name: 'Saved', shown: true }),
    ])
  })

  it('offers the shipped samples too, and reports a hidden one as hidden', () => {
    writeSampleBundle(['pong'])
    const options = { root, vendor: 'acer', samplesRoot: bundle }
    expect(arcadeCatalog(options)).toEqual([
      expect.objectContaining({ kind: 'sample', id: 'pong', shown: true }),
    ])

    setArcadeShown({ kind: 'sample', id: 'pong', shown: false }, options)
    expect(arcadeCatalog(options)).toEqual([
      expect.objectContaining({ kind: 'sample', id: 'pong', shown: false }),
    ])
  })

  // A sample's icon sits a folder deeper than a game's, and the app window can
  // only load one through this scheme.
  it('addresses a sample icon through the nested path the renderer needs', () => {
    writeSampleBundle(['pong'])
    const [sample] = arcadeCatalog({ root, vendor: 'acer', samplesRoot: bundle })
    expect(sample.iconUrl).toBe('aipg-media://games/_arcade-samples/pong/icon.png')
  })

  // Samples are an Acer deliverable: elsewhere there is nothing to ask about, and
  // nothing may be copied in by the asking.
  it('offers no samples on a machine that is not an Acer', () => {
    writeSampleBundle(['pong'])
    expect(arcadeCatalog({ root, vendor: 'unknown', samplesRoot: bundle })).toEqual([])
    expect(fs.existsSync(path.join(root, '_arcade-samples'))).toBe(false)
  })
})

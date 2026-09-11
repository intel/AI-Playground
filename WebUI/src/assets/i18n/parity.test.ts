import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// en-US is the source of truth: the loader merges it as a fallback, so a missing
// key renders in English rather than crashing — which makes drift invisible
// without a check like this one.
// `fileURLToPath`, not `.pathname`: the raw pathname is percent-encoded and keeps
// the leading slash of a `file:///C:/…` URL, neither of which `readdirSync` takes.
const dir = path.dirname(fileURLToPath(import.meta.url))
const source = 'en-US.json'

const localeFiles = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== source)
  .sort()

const read = (file: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))

const english = read(source)

/** The `{placeholder}` tokens a translation must reproduce verbatim. */
const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{[^}]+\}/g)].map((match) => match[0]).sort()

describe('i18n parity', () => {
  it('finds the other locales', () => {
    // Named rather than counted, so adding a locale doesn't mean editing a magic
    // number, but dropping one still fails here instead of going unnoticed.
    const expected = [
      'de.json',
      'es.json',
      'id.json',
      'it.json',
      'ja.json',
      'ko.json',
      'pl.json',
      'th.json',
      'tr.json',
      'vi.json',
      'zh-CN.json',
      'zh-TW.json',
    ]
    expect(localeFiles).toEqual(expect.arrayContaining(expected))
    expect(localeFiles.length).toBeGreaterThanOrEqual(expected.length)
  })

  it.each(localeFiles)('%s has exactly the en-US key set', (file) => {
    const locale = read(file)
    const englishKeys = Object.keys(english)
    const localeKeys = Object.keys(locale)

    expect(englishKeys.filter((key) => !(key in locale))).toEqual([])
    expect(localeKeys.filter((key) => !(key in english))).toEqual([])
  })

  it.each(localeFiles)('%s preserves every placeholder token', (file) => {
    const locale = read(file)
    const mismatched = Object.entries(english)
      .filter(([key, value]) => {
        const translated = locale[key]
        if (typeof translated !== 'string') return false
        return placeholders(value).join(',') !== placeholders(translated).join(',')
      })
      .map(([key]) => key)

    expect(mismatched).toEqual([])
  })

  it.each(localeFiles)('%s has no empty translations', (file) => {
    const locale = read(file)
    const empty = Object.entries(locale)
      .filter(([, value]) => typeof value === 'string' && value.trim() === '')
      .map(([key]) => key)

    expect(empty).toEqual([])
  })
})

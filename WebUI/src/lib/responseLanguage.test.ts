import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isConversationStart,
  languageNameForLocale,
  RESPONSE_LANGUAGE_NAMES,
  responseLanguageInstruction,
  withResponseLanguage,
  withResponseLanguageAtStart,
} from './responseLanguage'

const i18nDir = path.resolve(fileURLToPath(import.meta.url), '../../assets/i18n')

describe('responseLanguage', () => {
  it('covers every shipped UI locale', () => {
    const locales = fs
      .readdirSync(i18nDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort()
    expect(locales.length).toBeGreaterThan(0)
    for (const locale of locales) {
      expect(RESPONSE_LANGUAGE_NAMES[locale], locale).toBeTruthy()
    }
    expect(Object.keys(RESPONSE_LANGUAGE_NAMES).sort()).toEqual(locales)
  })

  it('names known locales in English so the model can follow them', () => {
    expect(languageNameForLocale('ja')).toBe('Japanese')
    expect(languageNameForLocale('zh-CN')).toBe('Simplified Chinese')
    expect(languageNameForLocale('en-US')).toBe('English')
  })

  it('falls back to the locale tag when the language is unknown', () => {
    expect(languageNameForLocale('fr')).toBe('fr')
  })

  it('states the UI language as the default and yields to the user otherwise', () => {
    const instruction = responseLanguageInstruction('de')
    expect(instruction).toContain('German')
    expect(instruction).toMatch(/default response language/)
    expect(instruction).toMatch(/different language/)
    expect(instruction).toMatch(/takes priority/)
  })

  it('appends the instruction after the existing system prompt', () => {
    const result = withResponseLanguage('You are a helpful assistant.', 'ja')
    expect(result.startsWith('You are a helpful assistant.')).toBe(true)
    expect(result).toContain(responseLanguageInstruction('ja'))
    expect(result).toBe(`You are a helpful assistant.\n\n${responseLanguageInstruction('ja')}`)
  })

  it('is the whole prompt when the base system prompt is empty', () => {
    expect(withResponseLanguage('', 'ko')).toBe(responseLanguageInstruction('ko'))
    expect(withResponseLanguage('   \n', 'ko')).toBe(responseLanguageInstruction('ko'))
  })
})

describe('isConversationStart', () => {
  it('is true for an empty thread and for the first user message', () => {
    expect(isConversationStart([])).toBe(true)
    expect(isConversationStart([{ role: 'user' }])).toBe(true)
    expect(isConversationStart([{ role: 'user' }, { role: 'assistant' }])).toBe(true)
  })

  it('is false once a second user message exists', () => {
    expect(isConversationStart([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }])).toBe(
      false,
    )
  })
})

describe('withResponseLanguageAtStart', () => {
  const base = 'You are a helpful assistant.'

  it('stamps the clause on the opening turn only', () => {
    expect(withResponseLanguageAtStart(base, 'ja', [{ role: 'user' }])).toBe(
      withResponseLanguage(base, 'ja'),
    )
    expect(
      withResponseLanguageAtStart(base, 'ja', [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
      ]),
    ).toBe(base)
  })
})

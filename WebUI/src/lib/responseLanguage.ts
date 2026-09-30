/**
 * Maps a UI locale (the Language selector's `value`) to the English language
 * name the model should treat as the default response language.
 *
 * Kept next to the instruction so adding a locale file also means adding a name
 * here — `responseLanguage.test.ts` checks that every shipped locale is covered.
 */
export const RESPONSE_LANGUAGE_NAMES: Record<string, string> = {
  de: 'German',
  'en-US': 'English',
  es: 'Spanish',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  pl: 'Polish',
  th: 'Thai',
  tr: 'Turkish',
  vi: 'Vietnamese',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
}

export function languageNameForLocale(locale: string): string {
  return RESPONSE_LANGUAGE_NAMES[locale] ?? locale
}

/**
 * Default-response-language clause appended to chat / agent system prompts.
 * User messages that are clearly in another language, or that ask for a
 * different response language, take priority over this default.
 */
export function responseLanguageInstruction(locale: string): string {
  const language = languageNameForLocale(locale)
  return (
    `The user's interface language is ${language}. ` +
    `Use ${language} as the default response language. ` +
    `If the user clearly asks a question in a different language or specifically ` +
    `requests a different response language, that takes priority.`
  )
}

export function withResponseLanguage(systemPrompt: string, locale: string): string {
  const instruction = responseLanguageInstruction(locale)
  const base = systemPrompt.trimEnd()
  return base ? `${base}\n\n${instruction}` : instruction
}

/**
 * Opening model turn of a conversation: at most one user message. A regenerate
 * of the first reply still counts; a follow-up does not.
 */
export function isConversationStart(messages: ReadonlyArray<{ role: string }>): boolean {
  let users = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    users += 1
    if (users > 1) return false
  }
  return true
}

export function withResponseLanguageAtStart(
  systemPrompt: string,
  locale: string,
  messages: ReadonlyArray<{ role: string }>,
): string {
  if (!isConversationStart(messages)) return systemPrompt
  return withResponseLanguage(systemPrompt, locale)
}

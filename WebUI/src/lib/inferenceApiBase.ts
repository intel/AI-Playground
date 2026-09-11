const VERSIONED = /\/v\d+\/?$/

/** OpenAI-compatible API root: keep an existing /vN, otherwise append /v1. */
export function openAiApiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  return VERSIONED.test(trimmed) ? trimmed : `${trimmed}/v1`
}

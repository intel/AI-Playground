/**
 * Share of the context window a turn may ask back as output. The remainder is what
 * the prompt gets, so the two together can never exceed the window whatever the
 * prompt turns out to cost — which is not known when the request is built.
 */
const MAX_OUTPUT_TOKEN_SHARE = 0.5

/**
 * Bound a `max_output_tokens` setting by the window it has to fit inside.
 *
 * The setting comes from the preset (`maxNewTokens`) and is bounded only by the
 * number input's own `max`, so it is routinely larger than the entire window of the
 * model in use: the Assistant preset asks for 32768 against a 2048-token model.
 * llama.cpp quietly truncates such a request, but OVMS refuses the turn outright —
 * "Number of prompt tokens: 95 + max tokens value: 32768 exceeds model max length:
 * 2048" — so on OpenVINO every turn on a small model failed, with nothing in the UI
 * offering a way out.
 *
 * `contextWindow` of 0 or undefined means there is nothing to reason about (an
 * unknown model, or a cloud provider that published no `context_length`); the
 * setting passes through rather than being capped against an invented number.
 */
export function boundMaxOutputTokens(maxTokens: number, contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return maxTokens
  return Math.min(maxTokens, Math.max(1, Math.floor(contextWindow * MAX_OUTPUT_TOKEN_SHARE)))
}

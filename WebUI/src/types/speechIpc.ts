/**
 * Speech-server and speech-synthesis IPC (flat `electronAPI` members).
 *
 * The STT/TTS sub-servers run inside the OpenVINO backend service; the
 * start/stop/url channels manage them through the registry. Synthesis itself
 * is proxied through main so the request is not subject to the renderer's
 * CORS policy — many OpenAI-compatible `/audio/speech` servers (e.g. local
 * TTS fallbacks) do not answer the CORS preflight an `application/json` POST
 * triggers.
 */

/** One `/audio/speech` request main proxies on the renderer's behalf. */
export type SpeechSynthesisRequest = {
  baseURL: string
  model: string
  input: string
  voice?: string
  apiKey?: string
  format?: string
}

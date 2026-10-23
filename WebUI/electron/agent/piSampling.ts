import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

// ── Sampling on an agent request ─────────────────────────────────────────────
//
// `Model.samplingParams` is a pi-ai field. pi-ai merges it into an
// openai-completions body, and Pi 1.0 copies it onto a model at registration,
// but a session does not read a bag kept beside the model. Models here are
// registered without it, so everything the app sends
// alongside a local agent turn — the publisher's recommended sampling from
// models.json, the temperature the user set, and `chat_template_kwargs` with
// the thinking switch — was silently dropped, and only chat turns honoured it.
//
// `before_provider_request` is Pi's supported seam for this: it fires per
// request with the assembled body, and what a handler returns replaces it. The
// bag is read through a callback rather than captured, so a change between two
// steps of the same turn (planningPhase.ts switching thinking off once the plan
// is written) applies to the very next request.

export function createSamplingExtension(
  getSampling: () => Record<string, unknown> | undefined,
): ExtensionFactory {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const sampling = getSampling()
      if (!sampling || typeof event.payload !== 'object' || event.payload === null) return
      // Pi owns the shape of the request (model, messages, tools, stream); this
      // only adds the sampling fields on top.
      return { ...(event.payload as Record<string, unknown>), ...sampling }
    })
  }
}

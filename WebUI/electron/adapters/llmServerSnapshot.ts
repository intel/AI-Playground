// ── What the local LLM server actually is, right now ─────────────────────────
//
// A turn's numbers only mean something next to the server that produced them:
// which build of llama.cpp / OVMS, on which device, started with which flags.
// All three live in the main process (the renderer never sees the command line,
// and should not have to copy it), so tracing reads them straight off the
// service object instead of growing the IPC surface. The same lookup answers
// where that server is listening, which an agent session has to ask again for
// every request (see `llmServerBaseUrl`).
//
// The registry hands itself over here rather than being imported: importing it
// would pull every backend service — and the filesystem probing they do while
// loading — into anything that traces, agent sessions and their tests included.

/** The two backends that run an LLM server of their own. */
export type LocalLlmBackend = 'llamaCPP' | 'openVINO'

export type LlmServerSnapshot = {
  /** Installed backend version (llama.cpp build number, OVMS release tag). */
  backendVersion?: string
  /** Device the backend is set to (`GPU.0`, `NPU`, …). */
  device?: string
  /** Human-readable name of that device (`Intel Arc B580`, …). */
  deviceName?: string
  /** The running LLM server's command line, as one string. */
  serverArgs?: string
}

const SERVICE_NAME: Record<LocalLlmBackend, string> = {
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
}

/** Structural view of the two services, so neither class has to be imported. */
type LlmServiceShape = {
  get_info(): ApiServiceInformation
  llmServerArgs?(): string[] | null
}

type ServiceLookup = (serviceName: string) => unknown

let lookup: ServiceLookup | null = null

/** Called once by the service registry, as it is built. */
export function setLlmServiceLookup(find: ServiceLookup): void {
  lookup = find
}

/**
 * Version, device and launch line of the local LLM server, as far as they are
 * known. Every field is optional: the backend may not be running, may never
 * have started an LLM server, or may not report a version.
 */
/**
 * Where that backend can be reached right now, without the `/v1` suffix — or
 * undefined when it is unknown to the registry.
 *
 * The port is picked when the server launches, and the server is relaunched
 * often: every media call hands the GPU to ComfyUI and takes it back, in the
 * middle of an agent turn. So the URL is a fact with a short life, and anything
 * that outlives one request has to ask again rather than remember.
 */
export function llmServerBaseUrl(backend: LocalLlmBackend): string | undefined {
  const service = lookup?.(SERVICE_NAME[backend]) as LlmServiceShape | undefined
  return service?.get_info().baseUrl || undefined
}

export function llmServerSnapshot(backend: LocalLlmBackend): LlmServerSnapshot {
  const service = lookup?.(SERVICE_NAME[backend]) as LlmServiceShape | undefined
  if (!service) return {}
  const info = service.get_info()
  const args = service.llmServerArgs?.() ?? null
  const selected = info.devices?.find((entry) => entry.selected)
  return {
    ...(info.installedVersion?.version ? { backendVersion: info.installedVersion.version } : {}),
    ...(selected?.id ? { device: selected.id } : {}),
    ...(selected?.name ? { deviceName: selected.name } : {}),
    ...(args && args.length > 0 ? { serverArgs: args.join(' ') } : {}),
  }
}

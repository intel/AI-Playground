import { acceptHMRUpdate, defineStore } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { createAppError, extractMessage } from '../errors/appError'

/**
 * A remote OpenAI-compatible provider (e.g. a self-hosted or cloud LLM
 * endpoint). The API key is NOT stored here — only an encrypted blob on disk
 * via safeStorage in the main process (see `window.electronAPI.cloudProvider`).
 * `models` holds the ids fetched from the provider's `GET /v1/models`.
 */
/**
 * How a provider expects its API key to be attached. The OpenAI-compatible
 * request/response shape is identical across these — only the auth header
 * differs, so the proxy (cloudProxy.ts) branches on this alone.
 *  - `bearer`:    `Authorization: Bearer <key>` — OpenAI and virtually every
 *                 OpenAI-compatible endpoint (OpenRouter, Groq, Together,
 *                 Mistral, DeepSeek, xAI, and Anthropic's / Google's compat
 *                 endpoints, plus local vLLM).
 *  - `x-api-key`: `x-api-key: <key>` — Anthropic's native surface.
 *  - `api-key`:   `api-key: <key>` — Azure OpenAI.
 */
export type CloudAuthStyle = 'bearer' | 'x-api-key' | 'api-key'

/**
 * A known provider the setup UI can prefill (base URL + auth scheme). Purely a
 * convenience: the user can still hand-edit every field afterwards, and the
 * `Custom` seed provider covers anything not listed here.
 */
export type CloudProviderPreset = {
  /** Stable prefill key (not a provider-instance id). */
  key: string
  name: string
  baseUrl: string
  authStyle: CloudAuthStyle
  /** Where to get an API key — surfaced as a hint in the setup UI. */
  apiKeyUrl?: string
}

// Curated OpenAI-compatible providers. Every entry here works through the
// existing chat client with only a base URL + key; auth style is carried so the
// list can later include surfaces that need a different header (Anthropic
// native, Azure) without changing the plumbing.
export const CLOUD_PROVIDER_PRESETS: CloudProviderPreset[] = [
  {
    key: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    key: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://console.groq.com/keys',
  },
  {
    key: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    key: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://console.x.ai',
  },
  {
    key: 'gemini',
    name: 'Google Gemini (OpenAI-compatible)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authStyle: 'bearer',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    key: 'anthropic',
    name: 'Anthropic (OpenAI-compatible)',
    baseUrl: 'https://api.anthropic.com/v1',
    authStyle: 'bearer',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
]

/** Capabilities that gate capability-scoped chat presets (Vision, tool-calling,
 *  reasoning). Remote providers rarely advertise these in a standard way, so we
 *  parse what we can and otherwise assume the model is fully capable. */
export type CloudModelCapabilities = {
  supportsVision: boolean
  supportsToolCalling: boolean
  supportsReasoning: boolean
}

// Default assumption for a remote model: fully capable. A provider that doesn't
// advertise capabilities shouldn't have its models filtered out of presets like
// Vision — better to offer the model and let a genuinely-unsupported request
// fail loudly than to hide it. Used both per-model (no metadata) and as the
// whole-fetch fallback when capability parsing throws.
export const ASSUME_ALL_CAPABILITIES: CloudModelCapabilities = {
  supportsVision: true,
  supportsToolCalling: true,
  supportsReasoning: true,
}

export type CloudProvider = {
  id: string
  name: string
  baseUrl: string
  models: string[]
  // How the API key is attached upstream. Absent = 'bearer' (the default and
  // the scheme every shipped preset uses).
  authStyle?: CloudAuthStyle
  // Per-model capabilities parsed from the provider's /v1/models response. A
  // model missing from this map is assumed fully capable (ASSUME_ALL_CAPABILITIES).
  modelCapabilities?: Record<string, CloudModelCapabilities>
}

/**
 * Best-effort capability extraction from a single `/v1/models` entry. Vanilla
 * OpenAI returns only `{ id }`, but many providers (OpenRouter, vLLM, LiteLLM,
 * …) attach `capabilities`, `architecture.input_modalities`, or
 * `supported_parameters`. When an entry advertises none of these we assume it's
 * fully capable; when it does advertise, a missing signal means "not supported".
 */
function parseModelCapabilities(model: Record<string, unknown>): CloudModelCapabilities {
  const caps = model.capabilities as Record<string, unknown> | undefined
  const architecture = model.architecture as Record<string, unknown> | undefined
  const supportedParams = model.supported_parameters

  const asLowerArray = (v: unknown): string[] =>
    (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []).map((s) =>
      s.toLowerCase(),
    )

  // OpenRouter uses `input_modalities: ['text','image']`; some use a single
  // `modality: 'text+image->text'` string — substring matching covers both.
  const modalities = asLowerArray(architecture?.input_modalities ?? architecture?.modality)
  const params = asLowerArray(supportedParams)

  const advertised = !!caps || !!architecture || Array.isArray(supportedParams)
  if (!advertised) return { ...ASSUME_ALL_CAPABILITIES }

  const flag = (v: unknown) => v === true
  return {
    supportsVision: flag(caps?.vision) || modalities.some((m) => m.includes('image')),
    supportsToolCalling:
      flag(caps?.tools) || flag(caps?.function_calling) || params.includes('tools'),
    supportsReasoning:
      flag(caps?.reasoning) || params.includes('reasoning') || params.includes('include_reasoning'),
  }
}

// Model id offered when a provider exposes no models (none fetched, or the
// provider doesn't implement /v1/models). Many OpenAI-compatible endpoints serve
// a single model and accept a request with a placeholder model id, so this lets
// the user select Cloud Mode and chat without first specifying a model.
export const CLOUD_DEFAULT_MODEL = 'default'

// Seed provider shown on first open. The user fills in base URL + key.
const DEFAULT_PROVIDER: CloudProvider = {
  id: 'custom',
  name: 'Custom',
  baseUrl: '',
  models: [],
}

export const useCloudMode = defineStore(
  'cloudMode',
  () => {
    // Mirrors `isCloudModeEnabled` from local settings. Hydrated on init().
    const isFeatureEnabled = ref(false)

    const providers = ref<CloudProvider[]>([{ ...DEFAULT_PROVIDER }])
    const selectedProviderId = ref<string>(DEFAULT_PROVIDER.id)

    // Decrypted API keys, kept in memory for the session only (never persisted
    // in the renderer). Populated lazily from safeStorage via loadApiKey().
    const apiKeyCache = reactive<Record<string, string>>({})

    const selectedProvider = computed<CloudProvider | undefined>(() =>
      providers.value.find((p) => p.id === selectedProviderId.value),
    )

    const activeProviderBaseUrl = computed<string | undefined>(() => {
      const url = selectedProvider.value?.baseUrl?.trim()
      if (!url) return undefined
      // Normalize: callers append `/v1/`, so strip a trailing slash (and a
      // trailing `/v1` if the user pasted the full base) to avoid `//v1/`.
      return url.replace(/\/+$/, '').replace(/\/v1$/, '')
    })

    const activeProviderApiKey = computed<string | undefined>(() => {
      const id = selectedProviderId.value
      return id ? apiKeyCache[id] : undefined
    })

    // Auth scheme for the selected provider; the chat path sends this to the
    // proxy so the key is attached with the right header (see cloudProxy.ts).
    const activeProviderAuthStyle = computed<CloudAuthStyle>(
      () => selectedProvider.value?.authStyle ?? 'bearer',
    )

    // Loopback base URL of the main-process Cloud proxy (see cloudProxy.ts).
    // All cloud networking flows through it, so upstream failures are logged in
    // the Node console instead of surfacing as opaque fetch errors in the browser.
    const proxyUrl = ref<string>('')

    async function ensureProxyUrl(): Promise<string> {
      if (!proxyUrl.value) {
        proxyUrl.value = await window.electronAPI.cloudProvider.getProxyUrl()
      }
      return proxyUrl.value
    }

    function selectProvider(id: string) {
      selectedProviderId.value = id
    }

    function addProvider(provider: Omit<CloudProvider, 'models'> & { models?: string[] }) {
      providers.value.push({ models: [], ...provider })
    }

    // Normalized comparison form of a base URL, so `https://x/v1` and `https://x/`
    // don't read as a change (callers append `/v1/` — see activeProviderBaseUrl).
    const normalizeBase = (url: string | undefined): string =>
      (url ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')

    // A previously fetched model list belongs to a specific endpoint + credential.
    // Once either changes, the ids may be stale (foreign endpoint) or newly
    // (un)authorized, so drop them and let the UI re-fetch under the new settings.
    function dropFetchedModels(provider: CloudProvider) {
      provider.models = []
      provider.modelCapabilities = undefined
    }

    function updateProvider(id: string, patch: Partial<Omit<CloudProvider, 'id'>>) {
      const provider = providers.value.find((p) => p.id === id)
      if (!provider) return
      // A base-URL change invalidates any list fetched from the old endpoint.
      // Skip when the patch itself carries a fresh `models` array (e.g. fetchModels
      // results applied through here) so we don't clobber the incoming list.
      if (
        patch.baseUrl !== undefined &&
        patch.models === undefined &&
        normalizeBase(patch.baseUrl) !== normalizeBase(provider.baseUrl)
      ) {
        dropFetchedModels(provider)
      }
      Object.assign(provider, patch)
    }

    async function removeProvider(id: string) {
      providers.value = providers.value.filter((p) => p.id !== id)
      delete apiKeyCache[id]
      await window.electronAPI.cloudProvider.deleteKey(id).catch(() => undefined)
      if (selectedProviderId.value === id) {
        selectedProviderId.value = providers.value[0]?.id ?? ''
      }
    }

    /** Persist the key (encrypted) and cache the plaintext for this session. */
    async function saveApiKey(
      id: string,
      key: string,
    ): Promise<{ success: boolean; error?: string }> {
      const result = await window.electronAPI.cloudProvider.saveKey(id, key)
      if (result.success) {
        const trimmed = key.trim()
        const previous = apiKeyCache[id]
        if (trimmed) apiKeyCache[id] = trimmed
        else delete apiKeyCache[id]
        // A changed token can grant a different set of models (or revoke legacy
        // ones the old key could see), so any previously fetched list is stale.
        if (trimmed !== (previous ?? '')) {
          const provider = providers.value.find((p) => p.id === id)
          if (provider) dropFetchedModels(provider)
        }
      }
      return result
    }

    /** Pull the decrypted key from safeStorage into the in-memory cache. */
    async function loadApiKey(id: string): Promise<string | null> {
      const key = await window.electronAPI.cloudProvider.getKey(id)
      if (key) apiKeyCache[id] = key
      return key
    }

    /**
     * Fetch the provider's model ids via the main-process proxy
     * (`GET {proxy}/v1/models`, routed to the provider's `{baseUrl}/v1/models`)
     * and store them on the provider. The proxy attaches the API key and logs
     * upstream failures in the Node console; here we only surface a concise
     * message. Returns the list on success.
     */
    async function fetchModels(id: string): Promise<string[]> {
      const provider = providers.value.find((p) => p.id === id)
      if (!provider) throw new Error('Provider not found')
      const base = provider.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
      if (!base) throw new Error('Base URL is required')

      const proxy = await ensureProxyUrl()
      const url = `${proxy}/v1/models`

      let response: Response
      try {
        // Only routing headers — the key stays in main and is attached there,
        // using the provider's auth scheme.
        response = await fetch(url, {
          headers: {
            'X-Cloud-Upstream': base,
            'X-Cloud-Provider': id,
            'X-Cloud-Auth-Style': provider.authStyle ?? 'bearer',
          },
        })
      } catch (e) {
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-unreachable',
          surface: 'inline',
          userMessage: 'Could not reach the Cloud Mode proxy. Try restarting the app.',
          technicalMessage: `GET ${url} threw: ${extractMessage(e)}`,
          context: { providerId: id, upstream: base },
          cause: e,
        })
      }

      if (!response.ok) {
        // The proxy relays the provider's status/body and has already logged the
        // full detail to the Node console; surface a concise message here.
        const body = await response.text().catch(() => '')
        const snippet = body.trim().slice(0, 300)
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-http-error',
          surface: 'inline',
          userMessage:
            `Failed to fetch models: HTTP ${response.status} ${response.statusText}` +
            (snippet ? ` — ${snippet}` : ''),
          technicalMessage: `GET ${url} (upstream ${base}) -> ${response.status}: ${body}`,
          context: { providerId: id, upstream: base, status: response.status },
        })
      }

      let json: { data?: Array<Record<string, unknown>> }
      try {
        json = (await response.json()) as { data?: Array<Record<string, unknown>> }
      } catch (e) {
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-bad-json',
          surface: 'inline',
          userMessage: 'Provider response was not valid JSON (expected an OpenAI /v1/models list).',
          technicalMessage: `GET ${url} returned unparseable JSON: ${extractMessage(e)}`,
          context: { providerId: id, upstream: base },
          cause: e,
        })
      }

      const data = json.data ?? []
      const ids = data.map((m) => String(m.id ?? '')).filter(Boolean)

      // Also derive per-model capabilities so capability-gated presets (Vision,
      // tool-calling, reasoning) can offer these models. If parsing throws for
      // any reason, drop the map so every model falls back to "fully capable"
      // (see capabilitiesFor / ASSUME_ALL_CAPABILITIES).
      try {
        const caps: Record<string, CloudModelCapabilities> = {}
        for (const m of data) {
          const modelId = String(m.id ?? '')
          if (modelId) caps[modelId] = parseModelCapabilities(m)
        }
        provider.modelCapabilities = caps
      } catch {
        provider.modelCapabilities = undefined
      }

      provider.models = ids
      return ids
    }

    /**
     * Capabilities for a model of the currently-selected provider. Falls back to
     * fully-capable when the model wasn't seen during a fetch (e.g. the synthetic
     * CLOUD_DEFAULT_MODEL, a manually-typed id, or a provider that never returned
     * capability metadata).
     */
    function capabilitiesFor(name: string): CloudModelCapabilities {
      const map = selectedProvider.value?.modelCapabilities
      return map?.[name] ?? { ...ASSUME_ALL_CAPABILITIES }
    }

    /**
     * Refresh the selected provider's model list, overwriting it only if the
     * request succeeds. Failures are swallowed here (the main-process proxy logs
     * the detail in the Node console) so a background refresh never disrupts the
     * UI or clobbers a previously-fetched list. No-op without a base URL.
     */
    async function refreshSelectedProviderModels(): Promise<void> {
      const id = selectedProviderId.value
      const provider = providers.value.find((p) => p.id === id)
      if (!id || !provider?.baseUrl.trim()) return
      try {
        await fetchModels(id) // overwrites provider.models on success
      } catch {
        /* keep the existing list; the proxy already logged the reason */
      }
    }

    async function toggleFeature(enabled: boolean) {
      isFeatureEnabled.value = enabled
      await window.electronAPI.updateLocalSettings({ isCloudModeEnabled: enabled })
      // Warm up the proxy so the chat backend URL is ready before first use.
      if (enabled) ensureProxyUrl().catch(() => undefined)
    }

    /** Hydrate the feature flag and decrypted keys on startup. */
    async function initConfig() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isCloudModeEnabled
      } catch (e) {
        console.error('cloudMode.initConfig: getLocalSettings failed:', e)
        isFeatureEnabled.value = false
      }
      if (!isFeatureEnabled.value) return
      // Start/resolve the proxy up front so the chat backend URL is ready.
      ensureProxyUrl().catch(() => undefined)
      // Re-load each provider's key from safeStorage into the session cache.
      await Promise.all(providers.value.map((p) => loadApiKey(p.id).catch(() => null)))
    }

    // Persisted providers/selection rehydrate after this store is created, so a
    // simple init() loop can miss the restored selection. Watch the selected
    // provider and lazily pull its key into the cache the first time we see it,
    // so the chat path always has the bearer token available after a restart.
    watch(
      () => selectedProviderId.value,
      (id) => {
        if (isFeatureEnabled.value && id && apiKeyCache[id] === undefined) {
          loadApiKey(id).catch(() => null)
        }
      },
      { immediate: true },
    )

    initConfig()

    return {
      isFeatureEnabled,
      providers,
      selectedProviderId,
      selectedProvider,
      activeProviderBaseUrl,
      activeProviderApiKey,
      activeProviderAuthStyle,
      proxyUrl,
      ensureProxyUrl,
      selectProvider,
      addProvider,
      updateProvider,
      removeProvider,
      saveApiKey,
      loadApiKey,
      fetchModels,
      capabilitiesFor,
      refreshSelectedProviderModels,
      toggleFeature,
      initConfig,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // Never persist API keys here — they live encrypted on disk via safeStorage.
      pick: ['providers', 'selectedProviderId'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCloudMode, import.meta.hot))
}

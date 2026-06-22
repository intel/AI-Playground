import type { LlmBackend } from '../store/textInference'

// Pure validation/diff logic for the configureHomeAgent tool. Kept free of any
// store imports so it can be unit-tested in isolation.

export type HomeAgentConfigRequest = {
  backend?: LlmBackend
  model?: string
  embeddingModel?: string
  deviceId?: string
  temperature?: number
  maxTokens?: number
  contextSize?: number
  systemPrompt?: string
  aipgToolsEnabled?: boolean
  mcpToolsEnabled?: boolean
  metricsEnabled?: boolean
  clearRagDocuments?: boolean
}

/** A single resolved change, used both to render the confirmation prompt and to apply. */
export type ConfigChange = {
  field: keyof HomeAgentConfigRequest
  label: string
  from: string
  /** Human-readable target (already clamped/normalized where relevant). */
  to: string
  /** Normalized value to actually apply (e.g. clamped contextSize). */
  value: unknown
}

export type ConfigContext = {
  currentBackend: LlmBackend
  current: {
    model: string | undefined
    embeddingModel: string | undefined
    deviceId: string | null
    temperature: number
    maxTokens: number
    contextSize: number
    systemPrompt: string
    aipgToolsEnabled: boolean
    mcpToolsEnabled: boolean
    metricsEnabled: boolean
    ragDocumentCount: number
  }
  /** Available LLM model names per backend (downloaded or not). */
  modelsByBackend: Record<LlmBackend, { name: string; maxContextSize?: number }[]>
  /** Available embedding model names (any backend). */
  embeddingModelNames: string[]
  /** Available device ids for the *target* backend's service. */
  deviceIds: string[]
}

export type ComputeResult = {
  changes: ConfigChange[]
  errors: string[]
  notes: string[]
}

function numbersDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > 1e-9
}

function shorten(value: string, max = 80): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * Resolve a config request against the current Home Agent settings into a
 * concrete list of changes, collecting validation errors and clamp notes.
 * Pure: takes a snapshot context, never touches stores. The target backend is
 * `req.backend ?? ctx.currentBackend` (a model/contextSize change applies to
 * whichever backend will be active after this request).
 */
export function computeConfigChanges(
  req: HomeAgentConfigRequest,
  ctx: ConfigContext,
): ComputeResult {
  const changes: ConfigChange[] = []
  const errors: string[] = []
  const notes: string[] = []

  const targetBackend = req.backend ?? ctx.currentBackend
  const targetModels = ctx.modelsByBackend[targetBackend] ?? []

  if (req.backend !== undefined && req.backend !== ctx.currentBackend) {
    changes.push({
      field: 'backend',
      label: 'Backend',
      from: ctx.currentBackend,
      to: req.backend,
      value: req.backend,
    })
  }

  if (req.model !== undefined) {
    const match = targetModels.find((m) => m.name === req.model)
    if (!match) {
      const available = targetModels.map((m) => m.name).join(', ') || '(none downloaded)'
      errors.push(
        `Unknown model "${req.model}" for backend ${targetBackend}. Available: ${available}.`,
      )
    } else if (req.model !== ctx.current.model || targetBackend !== ctx.currentBackend) {
      changes.push({
        field: 'model',
        label: 'Model',
        from: ctx.current.model ?? '(none)',
        to: req.model,
        value: req.model,
      })
    }
  }

  if (req.embeddingModel !== undefined) {
    if (!ctx.embeddingModelNames.includes(req.embeddingModel)) {
      const available = ctx.embeddingModelNames.join(', ') || '(none downloaded)'
      errors.push(`Unknown embedding model "${req.embeddingModel}". Available: ${available}.`)
    } else if (req.embeddingModel !== ctx.current.embeddingModel) {
      changes.push({
        field: 'embeddingModel',
        label: 'Embedding model',
        from: ctx.current.embeddingModel ?? '(none)',
        to: req.embeddingModel,
        value: req.embeddingModel,
      })
    }
  }

  if (req.deviceId !== undefined) {
    if (!ctx.deviceIds.includes(req.deviceId)) {
      const available = ctx.deviceIds.join(', ') || '(none)'
      errors.push(
        `Unknown device "${req.deviceId}" for backend ${targetBackend}. Available: ${available}.`,
      )
    } else if (req.deviceId !== ctx.current.deviceId) {
      changes.push({
        field: 'deviceId',
        label: 'Device',
        from: ctx.current.deviceId ?? '(default)',
        to: req.deviceId,
        value: req.deviceId,
      })
    }
  }

  if (req.temperature !== undefined && numbersDiffer(req.temperature, ctx.current.temperature)) {
    changes.push({
      field: 'temperature',
      label: 'Temperature',
      from: String(ctx.current.temperature),
      to: String(req.temperature),
      value: req.temperature,
    })
  }

  if (req.maxTokens !== undefined && req.maxTokens !== ctx.current.maxTokens) {
    changes.push({
      field: 'maxTokens',
      label: 'Max tokens',
      from: String(ctx.current.maxTokens),
      to: String(req.maxTokens),
      value: req.maxTokens,
    })
  }

  if (req.contextSize !== undefined) {
    const max = targetModels.find(
      (m) => m.name === (req.model ?? ctx.current.model),
    )?.maxContextSize
    let value = req.contextSize
    if (max !== undefined && value > max) {
      notes.push(`Context size clamped from ${req.contextSize} to the model maximum of ${max}.`)
      value = max
    }
    if (value !== ctx.current.contextSize) {
      changes.push({
        field: 'contextSize',
        label: 'Context size',
        from: String(ctx.current.contextSize),
        to: String(value),
        value,
      })
    }
  }

  if (
    req.systemPrompt !== undefined &&
    req.systemPrompt.trim() !== ctx.current.systemPrompt.trim()
  ) {
    changes.push({
      field: 'systemPrompt',
      label: 'System prompt',
      from: shorten(ctx.current.systemPrompt) || '(empty)',
      to: shorten(req.systemPrompt) || '(empty)',
      value: req.systemPrompt,
    })
  }

  const boolFields: {
    key: 'aipgToolsEnabled' | 'mcpToolsEnabled' | 'metricsEnabled'
    label: string
  }[] = [
    { key: 'aipgToolsEnabled', label: 'Built-in tools' },
    { key: 'mcpToolsEnabled', label: 'MCP tools' },
    { key: 'metricsEnabled', label: 'Performance metrics' },
  ]
  for (const { key, label } of boolFields) {
    const requested = req[key]
    if (requested !== undefined && requested !== ctx.current[key]) {
      changes.push({
        field: key,
        label,
        from: ctx.current[key] ? 'on' : 'off',
        to: requested ? 'on' : 'off',
        value: requested,
      })
    }
  }

  if (req.clearRagDocuments === true && ctx.current.ragDocumentCount > 0) {
    changes.push({
      field: 'clearRagDocuments',
      label: 'Knowledge base',
      from: `${ctx.current.ragDocumentCount} document(s)`,
      to: 'cleared',
      value: true,
    })
  }

  return { changes, errors, notes }
}

/** Render a markdown confirmation summary from the resolved changes + notes. */
export function summarizeChanges(changes: ConfigChange[], notes: string[]): string {
  const lines = changes.map((c) => `- **${c.label}**: ${c.from} → ${c.to}`)
  const noteLines = notes.map((n) => `_${n}_`)
  return ['I would like to update the Home Agent settings:', '', ...lines, ...noteLines].join('\n')
}

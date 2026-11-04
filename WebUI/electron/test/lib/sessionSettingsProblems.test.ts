import { describe, expect, it } from 'vitest'
import {
  sessionSettingsProblems,
  type SessionSettingsAvailability,
} from '@/lib/sessionSettingsProblems'

const available = (
  overrides: Partial<SessionSettingsAvailability> = {},
): SessionSettingsAvailability => ({
  models: [
    { name: 'Qwen3-9B', type: 'llamaCPP' },
    { name: 'Phi-4', type: 'openVINO' },
  ],
  embeddingModels: [{ name: 'bge-small', type: 'llamaCPP' }],
  services: [
    { backend: 'llamaCPP', isSetUp: true },
    { backend: 'openVINO', isSetUp: true },
  ],
  cloudEnabled: true,
  cloudProviderIds: ['zai'],
  mcpServerIds: ['blender'],
  embeddingBackend: 'llamaCPP',
  ...overrides,
})

const fields = (problems: { field: string }[]) => problems.map((p) => p.field)

describe('sessionSettingsProblems', () => {
  it('finds nothing wrong with usable settings', () => {
    const settings = {
      backend: 'llamaCPP' as const,
      model: 'Qwen3-9B',
      device: { id: 'GPU.0', uuid: 'u-arc' },
      capabilities: ['rag', 'mcp:blender'],
      embeddingModel: 'bge-small',
    }
    expect(sessionSettingsProblems(settings, available())).toEqual([])
  })

  it('names a model that is no longer in the catalog for its backend', () => {
    const problems = sessionSettingsProblems({ backend: 'llamaCPP', model: 'Phi-4' }, available())
    expect(problems).toEqual([{ field: 'model', value: 'Phi-4' }])
  })

  it('does not count a catalog model that is merely not downloaded', () => {
    // The catalog lists models whether or not they are on disk; the download dialog handles it.
    expect(
      sessionSettingsProblems({ backend: 'llamaCPP', model: 'Qwen3-9B' }, available()),
    ).toEqual([])
  })

  it('names a backend that is not installed', () => {
    const problems = sessionSettingsProblems(
      { backend: 'openVINO', model: 'Phi-4' },
      available({
        services: [{ backend: 'openVINO', isSetUp: false }],
      }),
    )
    expect(fields(problems)).toEqual(['backend'])
  })

  it('never blocks on a device an older Session stored, since the device is machine-wide', () => {
    expect(
      sessionSettingsProblems({ backend: 'llamaCPP', device: { id: 'GPU.7' } }, available()),
    ).toEqual([])
  })

  it('names cloud when Cloud Mode is off, and a removed provider', () => {
    expect(
      fields(sessionSettingsProblems({ backend: 'cloud' }, available({ cloudEnabled: false }))),
    ).toEqual(['backend'])
    expect(
      sessionSettingsProblems({ backend: 'cloud', cloudProviderId: 'gone' }, available()),
    ).toEqual([{ field: 'cloudProvider', value: 'gone' }])
  })

  it('names an enabled MCP server that no longer exists', () => {
    expect(sessionSettingsProblems({ capabilities: ['mcp:removed', 'web'] }, available())).toEqual([
      { field: 'mcpServer', value: 'removed' },
    ])
  })

  it('names an embedding model that is gone, only while document search is enabled', () => {
    expect(
      sessionSettingsProblems({ capabilities: ['rag'], embeddingModel: 'gone' }, available()),
    ).toEqual([{ field: 'embeddingModel', value: 'gone' }])
    expect(
      sessionSettingsProblems({ capabilities: [], embeddingModel: 'gone' }, available()),
    ).toEqual([])
  })

  it('skips any check whose list has not loaded yet', () => {
    const settings = {
      backend: 'llamaCPP' as const,
      model: 'Gone',
      device: { id: 'GPU.9' },
      capabilities: ['rag', 'mcp:removed'],
      embeddingModel: 'gone',
    }
    const unloaded = available({
      models: [],
      embeddingModels: [],
      services: [{ backend: 'llamaCPP', isSetUp: true }],
      mcpServerIds: null,
    })
    expect(sessionSettingsProblems(settings, unloaded)).toEqual([])
  })
})

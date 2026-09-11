import { describe, expect, it } from 'vitest'
import { AgentModeTurnConfigSchema } from '@/types/agentIpc'

const localConfig = {
  sessionId: 's1',
  workspaceDir: '/tmp/ws',
  modelConfig: {
    source: 'local' as const,
    model: 'qwen',
    baseUrl: 'http://127.0.0.1:39000/v1',
  },
}

describe('AgentModeTurnConfigSchema', () => {
  it('accepts a local turn config', () => {
    const parsed = AgentModeTurnConfigSchema.safeParse(localConfig)
    expect(parsed.success).toBe(true)
  })

  it('accepts a cloud turn config', () => {
    const parsed = AgentModeTurnConfigSchema.safeParse({
      sessionId: 's1',
      workspaceDir: '/tmp/ws',
      modelConfig: {
        source: 'cloud',
        model: 'gpt-4o',
        proxyBaseUrl: 'http://127.0.0.1:9',
        upstreamBaseUrl: 'https://api.example',
        providerId: 'openai',
        authStyle: 'bearer',
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a missing session id or workspace', () => {
    expect(AgentModeTurnConfigSchema.safeParse({ ...localConfig, sessionId: '' }).success).toBe(
      false,
    )
    const { workspaceDir: _workspaceDir, ...rest } = localConfig
    expect(AgentModeTurnConfigSchema.safeParse(rest).success).toBe(false)
  })
})

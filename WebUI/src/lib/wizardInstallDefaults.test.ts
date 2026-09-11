import { describe, expect, it } from 'vitest'
import {
  CORE_DEPENDENT_BACKENDS,
  OPT_IN_BACKENDS,
  isCoreDependentBackend,
  selectDefaultInstalls,
  type SeedCandidate,
} from './wizardInstallDefaults'

/** A machine where nothing is installed yet and every component is offered. */
function freshMachine(): SeedCandidate[] {
  return [
    { serviceName: 'ai-backend', isRequired: true, isSetUp: false, ...offered() },
    { serviceName: 'home-agent-backend', isRequired: false, isSetUp: false, ...offered() },
    { serviceName: 'qwen3-tts-backend', isRequired: false, isSetUp: false, ...offered() },
    { serviceName: 'whisper-backend', isRequired: false, isSetUp: false, ...offered() },
    { serviceName: 'llamacpp-backend', isRequired: false, isSetUp: false, ...offered() },
    { serviceName: 'openvino-backend', isRequired: false, isSetUp: false, ...offered() },
    { serviceName: 'comfyui-backend', isRequired: false, isSetUp: false, ...offered() },
  ]
}

function offered() {
  return { availableInProductMode: true, userDisabled: false }
}

function withCandidate(
  candidates: SeedCandidate[],
  serviceName: BackendServiceName,
  patch: Partial<SeedCandidate>,
): SeedCandidate[] {
  return candidates.map((c) => (c.serviceName === serviceName ? { ...c, ...patch } : c))
}

describe('selectDefaultInstalls', () => {
  it('pre-selects the inference engines and the speech runtimes on a fresh machine', () => {
    const selected = selectDefaultInstalls(freshMachine())

    expect(selected).toContain('comfyui-backend')
    expect(selected).toContain('openvino-backend')
    expect(selected).toContain('llamacpp-backend')
    expect(selected).toContain('qwen3-tts-backend')
    expect(selected).toContain('whisper-backend')
  })

  it('omits required components — they install regardless and their row is locked', () => {
    expect(selectDefaultInstalls(freshMachine())).not.toContain('ai-backend')
  })

  it('leaves Home Agent off on a machine that does not have it', () => {
    expect(selectDefaultInstalls(freshMachine())).not.toContain('home-agent-backend')
  })

  it('pre-selects Home Agent once it is installed, so reopening the wizard keeps it', () => {
    const candidates = withCandidate(freshMachine(), 'home-agent-backend', { isSetUp: true })

    expect(selectDefaultInstalls(candidates)).toContain('home-agent-backend')
  })

  it('respects an installed Home Agent the user switched off', () => {
    const candidates = withCandidate(freshMachine(), 'home-agent-backend', {
      isSetUp: true,
      userDisabled: true,
    })

    expect(selectDefaultInstalls(candidates)).not.toContain('home-agent-backend')
  })

  it('skips OpenVINO when the pending product mode cannot offer it (NVIDIA)', () => {
    const candidates = withCandidate(freshMachine(), 'openvino-backend', {
      availableInProductMode: false,
    })
    const selected = selectDefaultInstalls(candidates)

    expect(selected).not.toContain('openvino-backend')
    expect(selected).toContain('comfyui-backend')
  })

  it('keeps a component the user switched off out of the selection', () => {
    const candidates = withCandidate(freshMachine(), 'comfyui-backend', { userDisabled: true })

    expect(selectDefaultInstalls(candidates)).not.toContain('comfyui-backend')
  })

  it('leaves standard llama.cpp to the aiDAPTIV+ row on a fresh Phison machine', () => {
    const candidates = withCandidate(freshMachine(), 'llamacpp-backend', {
      phisonOwnsLlamaCpp: true,
    })

    expect(selectDefaultInstalls(candidates)).not.toContain('llamacpp-backend')
  })

  it('still pre-selects a speech runtime the user has not opted out of, even uninstalled', () => {
    const selected = selectDefaultInstalls(freshMachine())

    for (const name of CORE_DEPENDENT_BACKENDS) {
      expect(selected).toContain(name)
    }
  })

  it('honours an explicit opt-out of a speech runtime behind the Core Services disclosure', () => {
    const candidates = withCandidate(freshMachine(), 'whisper-backend', { userDisabled: true })
    const selected = selectDefaultInstalls(candidates)

    expect(selected).not.toContain('whisper-backend')
    expect(selected).toContain('qwen3-tts-backend')
  })
})

describe('component classification', () => {
  it('treats only the two speech sidecars as core dependents', () => {
    expect([...CORE_DEPENDENT_BACKENDS]).toEqual(['qwen3-tts-backend', 'whisper-backend'])
    expect(isCoreDependentBackend('comfyui-backend')).toBe(false)
  })

  it('treats only Home Agent as opt-in', () => {
    expect([...OPT_IN_BACKENDS]).toEqual(['home-agent-backend'])
  })
})

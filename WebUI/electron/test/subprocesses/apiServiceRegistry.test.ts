import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiServiceRegistryImpl,
  peekApiServiceRegistry,
} from '../../subprocesses/apiServiceRegistry'
import type { ApiService } from '../../subprocesses/service'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  BrowserWindow: class {},
}))

const killStale = vi.hoisted(() => vi.fn())
vi.mock('../../subprocesses/processLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../subprocesses/processLifecycle')>()),
  killStaleProcesses: killStale,
}))

/** Only the surface the registry touches; the rest of ApiService is irrelevant here. */
function fakeService(partial: Partial<ApiService> & { name: string }): ApiService {
  return {
    currentStatus: 'notYetStarted',
    stop: vi.fn(async () => 'stopped' as BackendStatus),
    ...partial,
  } as unknown as ApiService
}

describe('reapOrphansFromPreviousSession', () => {
  beforeEach(() => {
    killStale.mockClear()
  })

  it('sweeps every backend in one pass and spares the pids the session owns', async () => {
    const registry = new ApiServiceRegistryImpl()
    registry.register(
      fakeService({
        name: 'ai-backend',
        orphanSignatures: () => [['/opt/service/.venv/bin/python', 'web_api.py']],
        ownedPids: () => [],
      }),
    )
    registry.register(
      fakeService({
        name: 'llamacpp-backend',
        orphanSignatures: () => [
          ['/opt/llama/standard/llama-server'],
          ['/opt/llama/phison/llama-server'],
        ],
        ownedPids: () => [4711],
      }),
    )

    await registry.reapOrphansFromPreviousSession()

    // One call: on Windows each scan costs a PowerShell start-up.
    expect(killStale).toHaveBeenCalledOnce()
    const [groups, options] = killStale.mock.calls[0]
    expect(groups).toEqual([
      {
        name: 'ai-backend',
        label: 'orphan',
        signatures: [['/opt/service/.venv/bin/python', 'web_api.py']],
      },
      {
        name: 'llamacpp-backend',
        label: 'orphan',
        signatures: [['/opt/llama/standard/llama-server'], ['/opt/llama/phison/llama-server']],
      },
    ])
    expect(options.excludePids).toEqual([4711])
  })

  it('leaves out services that expose no signature', async () => {
    const registry = new ApiServiceRegistryImpl()
    registry.register(fakeService({ name: 'openvino-backend' }))

    await registry.reapOrphansFromPreviousSession()

    expect(killStale).toHaveBeenCalledWith([], expect.anything())
  })
})

describe('peekApiServiceRegistry', () => {
  it('is null until the factory has started constructing the singleton', () => {
    expect(peekApiServiceRegistry()).toBeNull()
  })
})

describe('stopAllServices', () => {
  it('also stops services caught mid-flight, which still own a process', async () => {
    const registry = new ApiServiceRegistryImpl()
    const states: BackendStatus[] = [
      'running',
      'starting',
      'stopping',
      'failed',
      'notYetStarted',
      'notInstalled',
    ]
    for (const state of states) {
      registry.register(fakeService({ name: `svc-${state}`, currentStatus: state }))
    }

    const stopped = await registry.stopAllServices()

    expect(stopped.map((s) => s.serviceName)).toEqual([
      'svc-running',
      'svc-starting',
      'svc-stopping',
      'svc-failed',
    ])
  })
})

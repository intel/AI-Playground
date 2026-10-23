import { describe, expect, it, vi } from 'vitest'
import {
  ACER_CAMERA_DIRECT_PROCESSES,
  createCachedAcerCameraDirectProbe,
  queryAcerCameraDirectRunning,
  tasklistOutputIndicatesProcess,
} from '../../../adapters/hardware/acerCameraDirect'
import { buildCameraCaptureRegistry } from '../../../kernel/registries/cameraCapture'

describe('tasklistOutputIndicatesProcess', () => {
  it('matches a running process line', () => {
    const stdout = '"AcerCameraDirectW.exe","1234","Console","1","12,345 K"\r\n'
    expect(tasklistOutputIndicatesProcess(stdout, 'AcerCameraDirectW.exe')).toBe(true)
  })

  it('does not match when tasklist reports no tasks', () => {
    const stdout = 'INFO: No tasks are running which match the specified criteria.\r\n'
    expect(tasklistOutputIndicatesProcess(stdout, 'AcerCameraDirectW.exe')).toBe(false)
  })
})

describe('queryAcerCameraDirectRunning', () => {
  it('returns false off Windows', async () => {
    const runTasklist = vi.fn()
    await expect(queryAcerCameraDirectRunning('linux', runTasklist)).resolves.toBe(false)
    expect(runTasklist).not.toHaveBeenCalled()
  })

  it('stops at the first matching Acer Camera Direct process', async () => {
    const runTasklist = vi.fn(async (name: string) =>
      name === 'AcerCameraDirectW.exe'
        ? '"AcerCameraDirectW.exe","1","Console","1","1 K"'
        : 'INFO: No tasks are running which match the specified criteria.',
    )
    await expect(queryAcerCameraDirectRunning('win32', runTasklist)).resolves.toBe(true)
    expect(runTasklist.mock.calls.length).toBeLessThanOrEqual(ACER_CAMERA_DIRECT_PROCESSES.length)
    expect(runTasklist).toHaveBeenCalledWith('AcerCameraDirectW.exe')
  })

  it('tries the next process name when tasklist fails', async () => {
    const runTasklist = vi.fn(async (name: string) => {
      if (name === 'AcerCameraDirectService.exe') throw new Error('fail')
      if (name === 'AcerCameraDirectW.exe') return '"AcerCameraDirectW.exe","1","Console","1","1 K"'
      return 'INFO: No tasks are running which match the specified criteria.'
    })
    await expect(queryAcerCameraDirectRunning('win32', runTasklist)).resolves.toBe(true)
    expect(runTasklist).toHaveBeenCalledWith('AcerCameraDirectW.exe')
  })
})

describe('createCachedAcerCameraDirectProbe', () => {
  it('coalesces concurrent calls and respects cacheMs', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => true)
    const probe = createCachedAcerCameraDirectProbe(query, 2500)

    await expect(Promise.all([probe(), probe()])).resolves.toEqual([true, true])
    expect(query).toHaveBeenCalledTimes(1)

    await probe()
    expect(query).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2500)
    await probe()
    expect(query).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not stick a failed probe', async () => {
    const query = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('tasklist'))
      .mockResolvedValueOnce(false)
    const probe = createCachedAcerCameraDirectProbe(query, 2500)
    await expect(probe()).rejects.toThrow('tasklist')
    await expect(probe()).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('buildCameraCaptureRegistry', () => {
  function registryFor(acer: boolean, running: boolean | Error) {
    return buildCameraCaptureRegistry({
      isAcerMachine: async () => acer,
      isDirectRunning: () =>
        running instanceof Error ? Promise.reject(running) : Promise.resolve(running),
      logWarn: () => {},
      registerShortcut: () => true,
      unregisterShortcut: () => {},
    })
  }

  it('reports Camera Direct on an Acer machine, firmware or override', async () => {
    const ask = (acer: boolean, running: boolean) =>
      registryFor(acer, running)['cameraCapture:isDirectRunning'](undefined as never)

    await expect(ask(true, true)).resolves.toBe(true)
    await expect(ask(true, false)).resolves.toBe(false)
    await expect(ask(false, true)).resolves.toBe(false)
  })

  it('does not call the probe unless the machine is Acer', async () => {
    const isDirectRunning = vi.fn(async () => true)
    const registry = buildCameraCaptureRegistry({
      isAcerMachine: async () => false,
      isDirectRunning,
      logWarn: () => {},
      registerShortcut: () => true,
      unregisterShortcut: () => {},
    })
    await expect(registry['cameraCapture:isDirectRunning'](undefined as never)).resolves.toBe(false)
    expect(isDirectRunning).not.toHaveBeenCalled()
  })

  it('returns false when the probe throws', async () => {
    const registry = registryFor(true, new Error('tasklist'))
    await expect(registry['cameraCapture:isDirectRunning'](undefined as never)).resolves.toBe(false)
  })
})

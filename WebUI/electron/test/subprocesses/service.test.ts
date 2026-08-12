import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChildProcess } from 'node:child_process'
import { DeviceService, LongLivedPythonApiService } from '../../subprocesses/service'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

/**
 * Minimal concrete backend used to exercise the shared start() flow in
 * isolation. spawnAPIProcess records whether it was reached so tests can assert
 * the pre-start guard runs *before* the process is spawned.
 */
class FakeBackendService extends LongLivedPythonApiService {
  readonly isRequired = false
  healthEndpointUrl = `${this.baseUrl}/healthy`
  readonly pythonEnvDir = '/tmp/fake/.venv'
  readonly serviceDir = '/tmp/fake'
  isSetUp = true
  devices: InferenceDevice[] = []

  spawnCalled = false
  // Controls the base-class start guard: a false provisioning check must abort
  // startup before the process is spawned.
  setUpResult = true

  async serviceIsSetUp(): Promise<boolean> {
    return this.setUpResult
  }
  async detectDevices(): Promise<void> {}
  async *set_up(): AsyncIterable<SetupProgress> {}

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    this.spawnCalled = true
    // Should never be reached when the guard throws; return a stub with just
    // enough of the ChildProcess surface (stream .on, .once, .kill) for the
    // shared boot path otherwise.
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      once: vi.fn(),
      on: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess
    return { process: proc, didProcessExitEarlyTracker: Promise.resolve(false) }
  }
}

function makeFakeBackend(): FakeBackendService {
  const win = { webContents: { send: vi.fn() } } as unknown as ConstructorParameters<
    typeof FakeBackendService
  >[2]
  return new FakeBackendService('ai-backend' as BackendServiceName, 12345, win, {} as never)
}

describe('DeviceService', () => {
  let deviceService: DeviceService

  beforeEach(() => {
    vi.clearAllMocks()

    deviceService = new DeviceService()

    vi.spyOn(deviceService, 'run').mockImplementation(async () => {
      return JSON.stringify({
        device_list: [
          {
            device_id: 0,
            device_name: 'Intel(R) UHD Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:00:02.0',
            pci_device_id: '0x9a60',
            uuid: '00000000-0000-0200-0000-00019a608086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 1,
            device_name: 'Intel(R) Arc(TM) B580 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0xe20b',
            uuid: '00000000-0000-0003-0000-0000e20b8086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 2,
            device_name: 'Intel(R) Arc(TM) A770 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0x56a0',
            uuid: '00000000-0000-0003-0000-000856a08086',
            vendor_name: 'Intel(R) Corporation',
          },
        ],
      })
    })
  })

  describe('getExePath', () => {
    it('should return the correct path to xpu-smi.exe', () => {
      const exePath = deviceService.getExePath()
      expect(exePath).toContain(path.join('device-service', 'xpu-smi.exe'))
    })
  })
})

describe('LongLivedPythonApiService start guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails the start without spawning when the backend is not set up', async () => {
    const service = makeFakeBackend()
    service.setUpResult = false // serviceIsSetUp() → false triggers the base guard

    const status = await service.start()

    // The guard short-circuits startup: no process is spawned, the backend is
    // marked failed + not-set-up, and the error is captured for the wizard /
    // backend management screen to offer a reinstall.
    expect(service.spawnCalled).toBe(false)
    expect(status).toBe('failed')
    expect(service.isSetUp).toBe(false)
    const info = service.get_info()
    expect(info.status).toBe('failed')
    expect(info.isSetUp).toBe(false)
    expect(info.errorDetails?.stderr).toContain('not fully installed')
  })

  it('proceeds to spawn when the backend is set up', async () => {
    const service = makeFakeBackend()
    // serviceIsSetUp() → true → guard passes and startup continues into
    // spawnAPIProcess. listenServerReady is stubbed to report a clean boot.
    vi.spyOn(
      service as unknown as { listenServerReady: () => Promise<boolean> },
      'listenServerReady',
    ).mockResolvedValue(true)

    const status = await service.start()

    expect(service.spawnCalled).toBe(true)
    expect(status).toBe('running')
  })

  it('surfaces a subclass-specific guard message (e.g. TTS torch check)', async () => {
    // Mirrors Qwen3TtsBackendService.assertReadyToStart, which overrides the
    // base guard to explain the missing torch dependency.
    class CustomGuardBackend extends FakeBackendService {
      protected override async assertReadyToStart(): Promise<void> {
        this.isSetUp = false
        throw new Error('PyTorch is not installed — reinstall the Text To Speech backend.')
      }
    }
    const win = { webContents: { send: vi.fn() } } as unknown as ConstructorParameters<
      typeof CustomGuardBackend
    >[2]
    const service = new CustomGuardBackend(
      'qwen3-tts-backend' as BackendServiceName,
      57000,
      win,
      {} as never,
    )

    const status = await service.start()

    expect(service.spawnCalled).toBe(false)
    expect(status).toBe('failed')
    expect(service.get_info().errorDetails?.stderr).toContain('PyTorch is not installed')
  })
})

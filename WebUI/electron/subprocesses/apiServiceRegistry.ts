import { ApiService } from './service.ts'
import { ComfyUiBackendService } from './comfyUIBackendService.ts'
import { AiBackendService } from './aiBackendService.ts'
import { BrowserWindow } from 'electron'
import { isOnDemandBackend } from '@/lib/onDemandBackends'
import { appLoggerInstance } from '../logging/logger.ts'
import { killStaleProcesses } from './processLifecycle.ts'
import getPort, { portNumbers } from 'get-port'
import { LlamaCppBackendService } from './llamaCppBackendService.ts'
import { OpenVINOBackendService } from './openVINOBackendService.ts'
import { HomeAgentBackendService } from './homeAgentBackendService.ts'
import { Qwen3TtsBackendService } from './qwen3TtsBackendService.ts'
import { WhisperBackendService } from './whisperBackendService.ts'
import { LocalSettings } from '../main.ts'
import { setLlmServiceLookup } from '../llmServerSnapshot.ts'

export type backend =
  | 'ai-backend'
  | 'openvino-backend'
  | 'comfyui-backend'
  | 'llamacpp-backend'
  | 'home-agent-backend'
  | 'qwen3-tts-backend'
  | 'whisper-backend'

export interface ApiServiceRegistry {
  register(apiService: ApiService): void
  getRegistered(): ApiService[]
  getRequired(): ApiService[]
}

export class ApiServiceRegistryImpl implements ApiServiceRegistry {
  private registeredServices: ApiService[] = []
  private disabledBackends: string[] = []

  setDisabledBackends(names: string[]): void {
    this.disabledBackends = names
  }

  register(apiService: ApiService): void {
    if (this.registeredServices.includes(apiService)) {
      return
    }
    this.registeredServices.push(apiService)
  }

  getRegistered(): ApiService[] {
    return this.registeredServices
  }
  getRequired(): ApiService[] {
    const requiredServices = this.registeredServices.filter((item) => item.name === 'ai-backend')
    if (requiredServices.length !== 1) {
      throw Error("Required Service 'ai-backend' not yet registered")
    }
    return requiredServices
  }

  getService(serviceName: string): ApiService | undefined {
    return this.registeredServices.find((item) => item.name === serviceName)
  }

  async stopAllServices(): Promise<{ serviceName: string; state: BackendStatus }[]> {
    appLoggerInstance.info(`stopping all running services`, 'apiServiceRegistry')
    // 'running' is not the only state that owns a process: a service caught
    // mid-launch ('starting'), mid-stop ('stopping') or one that reported
    // 'failed' after spawning can all still have a live child, and skipping
    // those is how backends survived a quit.
    const statesThatMayOwnAProcess: BackendStatus[] = ['running', 'starting', 'stopping', 'failed']
    const stoppableServices = this.registeredServices.filter((item) =>
      statesThatMayOwnAProcess.includes(item.currentStatus),
    )
    return Promise.all(
      stoppableServices.map((service) =>
        service
          .stop()
          .then((state) => {
            appLoggerInstance.info(
              `service ${service.name} now in state ${state}`,
              'apiServiceRegistry',
            )
            return { serviceName: service.name, state }
          })
          .catch((e) => {
            appLoggerInstance.error(
              `Failed to stop service ${service.name} due to ${e}`,
              'apiServiceRegistry',
              true,
            )
            return { serviceName: service.name, state: 'failed' as BackendStatus }
          }),
      ),
    )
  }

  getServiceInformation(): ApiServiceInformation[] {
    return this.getRegistered().map((service) => service.get_info())
  }

  /**
   * Kill backends left running by a previous app session.
   *
   * A clean quit reaps everything, but a SIGKILL or a power loss cannot, and
   * third-party backends have no parent-death handling of their own. Matching is
   * by each backend's own binary path, so the pids this session already owns are
   * excluded — the sweep is safe to run at any time, not only at startup.
   */
  async reapOrphansFromPreviousSession(): Promise<void> {
    const groups = this.registeredServices
      .map((service) => ({
        name: service.name,
        label: 'orphan',
        signatures: service.orphanSignatures?.() ?? [],
      }))
      .filter((group) => group.signatures.length > 0)
    const ownPids = this.registeredServices.flatMap((service) => service.ownedPids?.() ?? [])
    await killStaleProcesses(groups, { excludePids: ownPids })
  }

  /**
   * Automatically start all services that are set up, except on-demand TTS/STT
   * sidecars (those start when a feature requests them, to preserve VRAM).
   * This runs in the background and doesn't block.
   * Waits for async setup checks to complete before starting services.
   */
  async startAllSetUpServices(disabledBackends: string[] = this.disabledBackends): Promise<void> {
    // Check setup status for all services.
    // Some services check asynchronously (ai-backend, comfyui-backend) and some synchronously (llamacpp-backend).
    // We'll check all services that have a serviceIsSetUp method and use the actual result,
    // rather than relying on the isSetUp property which may not be updated yet.
    const setupChecks = await Promise.all(
      this.registeredServices.map(async (service) => {
        // Check if service has async setup check method
        if (
          'serviceIsSetUp' in service &&
          typeof (service as unknown as { serviceIsSetUp?: unknown }).serviceIsSetUp === 'function'
        ) {
          const isSetUp = await (
            service as { serviceIsSetUp: () => Promise<boolean> }
          ).serviceIsSetUp()
          return { service, isSetUp }
        }
        // For services without async check, use the isSetUp property directly
        return { service, isSetUp: service.isSetUp }
      }),
    )

    // Filter to only services that are set up, are not being installed right
    // now, and that the user has not switched off in the setup wizard (that
    // choice is persisted in settings.json — see `disabledBackends`).
    const setUpServices = setupChecks
      .filter(({ isSetUp }) => isSetUp)
      .map(({ service }) => service)
      .filter((service) => {
        if (disabledBackends.includes(service.name)) {
          appLoggerInstance.info(
            `Not auto-starting ${service.name}: disabled by the user`,
            'apiServiceRegistry',
          )
          return false
        }
        if (service.setUpInProgress) {
          appLoggerInstance.info(
            `Not auto-starting ${service.name}: an installation is in progress`,
            'apiServiceRegistry',
          )
          return false
        }
        return true
      })

    if (setUpServices.length === 0) {
      appLoggerInstance.info('No services are set up to start', 'apiServiceRegistry')
      return
    }

    const autoStartServices = setUpServices.filter((service) => !isOnDemandBackend(service.name))
    const onDemandServices = setUpServices.filter((service) => isOnDemandBackend(service.name))
    if (onDemandServices.length > 0) {
      appLoggerInstance.info(
        `Not auto-starting on-demand backend(s) (started when requested): ${onDemandServices
          .map((s) => s.name)
          .join(', ')}`,
        'apiServiceRegistry',
      )
    }

    if (autoStartServices.length > 0) {
      appLoggerInstance.info(
        `Starting ${autoStartServices.length} backend service(s) automatically:`,
        'apiServiceRegistry',
      )
      appLoggerInstance.info(autoStartServices.map((s) => s.name).join(', '), 'apiServiceRegistry')
    } else {
      appLoggerInstance.info('No services are set up to auto-start', 'apiServiceRegistry')
    }

    // Detect devices for on-demand services so the device picker is accurate
    // before first use; do not start them (they occupy VRAM once running).
    Promise.all(
      onDemandServices.map(async (service) => {
        try {
          await service.detectDevices()
        } catch (error) {
          appLoggerInstance.error(
            `Failed to detect devices for ${service.name}: ${error}`,
            'apiServiceRegistry',
            true,
          )
        }
      }),
    ).catch((error) => {
      appLoggerInstance.error(
        `Error during on-demand device detection: ${error}`,
        'apiServiceRegistry',
        true,
      )
    })

    // Start remaining services in parallel, but don't block
    Promise.all(
      autoStartServices.map(async (service) => {
        try {
          // Detect devices first
          await service.detectDevices()
          await new Promise((resolve) => setTimeout(resolve, 100)) // Brief delay for device detection to settle

          // Start the service
          const status = await service.start()
          appLoggerInstance.info(
            `Service ${service.name} started with status: ${status}`,
            'apiServiceRegistry',
          )
        } catch (error) {
          appLoggerInstance.error(
            `Failed to start service ${service.name}: ${error}`,
            'apiServiceRegistry',
            true,
          )
        }
      }),
    ).catch((error) => {
      appLoggerInstance.error(
        `Error during automatic service startup: ${error}`,
        'apiServiceRegistry',
        true,
      )
    })
  }
}

let instance: ApiServiceRegistryImpl | null = null

/** Registry once construction has started; may still be missing later services. */
export function peekApiServiceRegistry(): ApiServiceRegistryImpl | null {
  return instance
}

export async function aiplaygroundApiServiceRegistry(
  win: BrowserWindow,
  settings: LocalSettings,
): Promise<ApiServiceRegistryImpl> {
  if (!instance) {
    instance = new ApiServiceRegistryImpl()
    // Lets tracing read a running LLM server's version and launch line without
    // importing this module (see electron/llmServerSnapshot.ts).
    setLlmServiceLookup((serviceName) => instance?.getService(serviceName))
    instance.register(
      new AiBackendService(
        'ai-backend',
        await getPort({ port: portNumbers(59000, 59999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new HomeAgentBackendService(
        'home-agent-backend',
        await getPort({ port: portNumbers(58000, 58999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new Qwen3TtsBackendService(
        'qwen3-tts-backend',
        await getPort({ port: portNumbers(57000, 57999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new WhisperBackendService(
        'whisper-backend',
        await getPort({ port: portNumbers(56000, 56999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new OpenVINOBackendService(
        'openvino-backend',
        await getPort({ port: portNumbers(29000, 29999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new ComfyUiBackendService(
        'comfyui-backend',
        await getPort({ port: portNumbers(49000, 49999) }),
        win,
        settings,
      ),
    )
    instance.register(
      new LlamaCppBackendService(
        'llamacpp-backend',
        await getPort({ port: portNumbers(39000, 39999) }),
        win,
        settings,
      ),
    )

    // Before anything of ours is spawned, so every match is genuinely a leftover
    // from an earlier session rather than a backend we just started.
    await instance.reapOrphansFromPreviousSession()

    // Automatically start all set-up services in the background
    // This happens regardless of frontend state, making it more reliable
    instance.setDisabledBackends(settings.disabledBackends ?? [])
    instance.startAllSetUpServices()
  }
  return instance
}

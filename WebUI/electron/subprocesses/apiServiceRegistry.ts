import { ApiService } from './service.ts'
import { ComfyUiBackendService } from './comfyUIBackendService.ts'
import { AiBackendService } from './aiBackendService.ts'
import { BrowserWindow } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import getPort, { portNumbers } from 'get-port'
import { LlamaCppBackendService } from './llamaCppBackendService.ts'
import { OpenVINOBackendService } from './openVINOBackendService.ts'
import { OllamaBackendService } from './ollamaBackendService.ts'
import { LocalSettings } from '../main.ts'

export type backend = 'ai-backend' | 'comfyui-backend' | 'ollama-backend'

export interface ApiServiceRegistry {
  register(apiService: ApiService): void
  getRegistered(): ApiService[]
  getRequired(): ApiService[]
}

export class ApiServiceRegistryImpl implements ApiServiceRegistry {
  private registeredServices: ApiService[] = []

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
    const runningServices = this.registeredServices.filter(
      (item) => item.currentStatus === 'running',
    )
    return Promise.all(
      runningServices.map((service) =>
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
   * Automatically start all services that are set up.
   * This runs in the background and doesn't block.
   * Waits for async setup checks to complete before starting services.
   */
  async startAllSetUpServices(): Promise<void> {
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

    // Filter to only services that are set up
    const setUpServices = setupChecks.filter(({ isSetUp }) => isSetUp).map(({ service }) => service)

    if (setUpServices.length === 0) {
      appLoggerInstance.info('No services are set up to start', 'apiServiceRegistry')
      return
    }

    appLoggerInstance.info(
      `Starting ${setUpServices.length} backend service(s) automatically:`,
      'apiServiceRegistry',
    )
    appLoggerInstance.info(setUpServices.map((s) => s.name).join(', '), 'apiServiceRegistry')

    // Start all services in parallel, but don't block
    Promise.all(
      setUpServices.map(async (service) => {
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

export async function aiplaygroundApiServiceRegistry(
  win: BrowserWindow,
  settings: LocalSettings,
): Promise<ApiServiceRegistryImpl> {
  if (!instance) {
    instance = new ApiServiceRegistryImpl()
    instance.register(
      new AiBackendService(
        'ai-backend',
        await getPort({ port: portNumbers(59000, 59999) }),
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
    if (settings.enablePreviewFeatures) {
      instance.register(
        new OllamaBackendService(
          'ollama-backend',
          await getPort({ port: portNumbers(40000, 41000) }),
          win,
          settings,
        ),
      )
    }

    // Automatically start all set-up services in the background
    // This happens regardless of frontend state, making it more reliable
    instance.startAllSetUpServices()
  }
  return instance
}

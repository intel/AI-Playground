import { ApiService } from './service.ts'
import { ComfyUiBackendService } from './comfyUIBackendService.ts'
import { AiBackendService } from './aiBackendService.ts'
import { BrowserWindow } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import getPort, { portNumbers } from 'get-port'
import { LlamaCppBackendService } from './llamaCppBackendService.ts'
import { OpenVINOBackendService } from './openVINOBackendService.ts'
import { OllamaBackendService } from './ollamaBackendService.ts'

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
  }
  return instance
}

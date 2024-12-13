import {ApiService} from "./apiService.ts";
import {ComfyUiBackendService, comfyUIBackendService} from "./comfyUIBackendService.ts";
import {AiBackendService, aiBackendService} from "./aiBackendService.ts";
import { BrowserWindow } from "electron";
import { appLoggerInstance } from "../logging/logger.ts";
import getPort, {portNumbers} from "get-port";

export type backend = 'ai-backend' | 'comfyui-backend'

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
        const requiredServices = this.registeredServices.filter(item => item.name === "ai-backend")
        if (requiredServices.length !== 1) {
            throw Error("Required Service 'ai-backend' not yet registered")
        }
        return requiredServices
    }

    getService(serviceName: string): ApiService | undefined {
        return this.registeredServices.find(item => item.name === serviceName)
    }

    async bootUpAllSetUpServices(): Promise<{ serviceName: string, state: BackendStatus }[]> {
        const setUpServices = this.registeredServices.filter(item => item.isSetUp)
        return Promise.all(setUpServices.map(service => service.start().then(
            state => {return  {serviceName: service.name, state}}
        ).catch((e) => {
            appLoggerInstance.error(`Failed to start service ${service.name} due to ${e}`, 'apiServiceRegistry', true)
            return {serviceName: service.name, state: "failed" as BackendStatus}
        })))
    }

    async stopAllServices(): Promise<{ serviceName: string, state: BackendStatus }[]> {
        appLoggerInstance.info(`stopping all running services`, 'apiServiceRegistry')
        const runningServices = this.registeredServices.filter(item => item.currentStatus === "running")
        return Promise.all(runningServices.map(service => service.stop().then(
            state => {
                appLoggerInstance.info(`service ${service.name} now in state ${state}`, 'apiServiceRegistry')
                return  {serviceName: service.name, state}
            }
        ).catch((e) => {
            appLoggerInstance.error(`Failed to stop service ${service.name} due to ${e}`, 'apiServiceRegistry', true)
            return {serviceName: service.name, state: "failed" as BackendStatus}
        })))
    }

    getServiceInformation(): ApiServiceInformation[] {
        return this.getRegistered().map(service => service.get_info())
    }
}

let instance:  ApiServiceRegistryImpl | null = null

export async function aiplaygroundApiServiceRegistry(win: BrowserWindow): Promise<ApiServiceRegistryImpl> {
    if (!instance) {
        instance = new ApiServiceRegistryImpl()
        instance.register(new AiBackendService('ai-backend', await getPort({port: portNumbers(59000, 59999)}), win))
        instance.register(new ComfyUiBackendService('comfyui-backend', await getPort({port: portNumbers(49000, 49999)}), win))
    }
    return instance
}

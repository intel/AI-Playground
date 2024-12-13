import {ApiService} from "./apiService.ts";
import {comfyUIBackendService} from "./comfyUIBackendService.ts";
import {aiBackendService} from "./aiBackendService.ts";
import { BrowserWindow } from "electron";
import { appLoggerInstance } from "../logging/logger.ts";

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

    getServiceInformation(): ApiServiceInformation[] {
        return this.getRegistered().map(service => service.get_info())
    }
}

let instance:  ApiServiceRegistryImpl | null = null

export async function aiplaygroundApiServiceRegistry(win: BrowserWindow): Promise<ApiServiceRegistryImpl> {
    if (!instance) {
        instance = new ApiServiceRegistryImpl()
        instance.register(await aiBackendService(win))
        instance.register(await comfyUIBackendService(win))
    }
    return instance
}

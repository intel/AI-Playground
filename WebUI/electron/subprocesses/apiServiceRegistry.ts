import {ApiService} from "./apiService.ts";
import {comfyUIBackendService} from "./comfyUIBackendService.ts";
import {aiBackendService} from "./aiBackendService.ts";

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

    async bootUpAllSetUpServices(): Promise<{ serviceName: string, state: BackendStatus }[]> {
        const setUpServices = this.registeredServices.filter(item => item.is_set_up())
        const allServerStartups = Promise.all(setUpServices.map(service => {
            const serverStatusPromise = service.start()
            return serverStatusPromise.then(stateResult => {return  {serviceName: service.name, state: stateResult}})
        }))
        return await allServerStartups
    }

    getServiceInformation(): ApiServiceInformation[] {
        return this.getRegistered().map(service => {
            return {
                serviceName: service.name,
                status: service.currentStatus,
                baseUrl: service.baseUrl,
                isSetUp: service.is_set_up(),
                isRequired: service.name === "ai-backend"
            }
        })
    }
}


let instance:  ApiServiceRegistryImpl | null = null

export async function aiplaygroundApiServiceRegistry(): Promise<ApiServiceRegistryImpl> {
    if (!instance) {
        instance = new ApiServiceRegistryImpl()
        instance.register(await aiBackendService())
        instance.register(await comfyUIBackendService())
    }
    return instance
}

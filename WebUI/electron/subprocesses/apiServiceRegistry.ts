import {ApiService} from "./apiService.ts";

export type backend = 'ai-backend' | 'comfyui-backend'


export interface ApiServiceRegistry {
    register(apiService: ApiService)
    deregister(apiService: ApiService)
    getRegistered(): ApiService[]
}
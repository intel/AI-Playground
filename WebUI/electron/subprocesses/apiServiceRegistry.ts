import {ApiService} from "./apiService.ts";

export type backend = 'ai-backend' | 'comfyui-backend'


export interface ApiServiceRegistry {
    register(apiService: ApiService): void
    deregister(apiService: ApiService): void
    getRegistered(): ApiService[]
    getRequired(): ApiService[]
}
import { shell } from 'electron'
import type { ComfyUiBackendService } from '../../adapters/backends/comfyUIBackendService'
import type * as comfyuiTools from '../../adapters/backends/comfyuiTools'
import { assertSafeCustomNodeRepoId } from '@/lib/customNodeRepoId'
import type { ComfyuiInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'

/**
 * The ComfyUI tool operations and live service lookup the ten comfyui
 * handlers close over. `comfyService` is an accessor: the registry is
 * built before the service registry exists, so the lookup stays lazy.
 */
export type ComfyuiDeps = {
  comfyService: () => ComfyUiBackendService | undefined
  comfyuiTools: typeof comfyuiTools
}

export function buildComfyuiRegistry(deps: ComfyuiDeps) {
  return {
    'comfyui:openInBrowser': async () => {
      const comfyService = deps.comfyService()
      if (!comfyService) {
        return { success: false as const, error: 'ComfyUI backend service not found' }
      }
      const baseUrl = comfyService.baseUrl
      if (!baseUrl) {
        return { success: false as const, error: 'ComfyUI backend has no base URL yet' }
      }
      const token = comfyService.getLoopbackAuthToken()
      // /aipg/launch (provided by the bundled aipg-auth custom_node) validates
      // launch_token against AIPG_LOOPBACK_TOKEN, then issues an HttpOnly,
      // SameSite=Strict aipg_session cookie and redirects to /. After that
      // the user's default browser uses the cookie for all subsequent
      // requests; the launch_token does not need to live in browser history.
      const url = `${baseUrl}/aipg/launch?launch_token=${encodeURIComponent(token)}`
      try {
        await shell.openExternal(url)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'comfyui:isGitInstalled': async () => {
      return await deps.comfyuiTools.isGitInstalled()
    },

    'comfyui:isComfyUIInstalled': () => {
      const comfyService = deps.comfyService()
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return deps.comfyuiTools.isComfyUIInstalled(comfyService.serviceDir)
    },

    'comfyui:getGitRef': async (_event, repoDir: string) => {
      return await deps.comfyuiTools.getGitRef(repoDir)
    },

    'comfyui:isPackageInstalled': async (_event, packageSpecifier: string) => {
      return await deps.comfyuiTools.isPackageInstalled(packageSpecifier)
    },

    'comfyui:installPypiPackage': async (_event, packageSpecifier: string) => {
      const comfyService = deps.comfyService()
      return await deps.comfyuiTools.installPypiPackage(
        packageSpecifier,
        comfyService?.getTorchBackendEnv(),
      )
    },

    'comfyui:isCustomNodeInstalled': (_event, nodeRepoRef) => {
      assertSafeCustomNodeRepoId(nodeRepoRef)
      const comfyService = deps.comfyService()
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return deps.comfyuiTools.isCustomNodeInstalled(nodeRepoRef, comfyService.serviceDir)
    },

    'comfyui:downloadCustomNode': async (_event, nodeRepoData) => {
      assertSafeCustomNodeRepoId(nodeRepoData)
      const comfyService = deps.comfyService()
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      const envAndWheels: comfyuiTools.ComfyUiInstallOptions = {
        extraEnv: comfyService.getTorchBackendEnv(),
        skipExtraWheels: comfyService.comfyUiVariantName !== 'xpu',
      }
      return await deps.comfyuiTools.downloadCustomNode(
        nodeRepoData,
        comfyService.serviceDir,
        envAndWheels,
      )
    },

    'comfyui:uninstallCustomNode': async (_event, nodeRepoData) => {
      assertSafeCustomNodeRepoId(nodeRepoData)
      const comfyService = deps.comfyService()
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return await deps.comfyuiTools.uninstallCustomNode(nodeRepoData, comfyService.serviceDir)
    },

    'comfyui:listInstalledCustomNodes': () => {
      const comfyService = deps.comfyService()
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return deps.comfyuiTools.listInstalledCustomNodes(comfyService.serviceDir)
    },
  } satisfies InvokeHandlerMap<ComfyuiInvokeName>
}

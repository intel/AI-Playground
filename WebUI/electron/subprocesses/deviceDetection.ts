import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appLoggerInstance as appLogger } from '../logging/logger.ts'

export function levelZeroDeviceSelectorEnv(id?: string): { ONEAPI_DEVICE_SELECTOR: string } {
  return { ONEAPI_DEVICE_SELECTOR: `level_zero:${id ?? '*'}` }
}

/** Restrict PyTorch/CUDA to one GPU. Omit when id is auto (`*` or undefined) so all devices stay visible. */
export function cudaVisibleDevicesEnv(id?: string): Record<string, string> {
  if (id === undefined || id === '*') {
    return {}
  }
  return { CUDA_VISIBLE_DEVICES: id }
}

export function vulkanDeviceSelectorEnv(id?: string): { GGML_VK_VISIBLE_DEVICES: string } {
  return { GGML_VK_VISIBLE_DEVICES: id ?? '0' }
}

export function openVinoDeviceSelectorEnv(id?: string): { OPENVINO_DEVICE: string } {
  return { OPENVINO_DEVICE: id ?? 'AUTO' }
}

// ---------------------------------------------------------------------------
// Linux shared-library detection (drives Intel-GPU backend selection)
// ---------------------------------------------------------------------------
// Detection must be robust across distros: hardcoded /usr/lib/x86_64-linux-gnu
// paths don't exist everywhere (Arch, Fedora, Nix, custom prefixes), so we also
// consult the dynamic linker cache via `ldconfig -p`. Results are cached and the
// decision is logged so it's visible in the in-app backend logs.
let _ldconfigCache: string | undefined
function ldconfigOutput(): string {
  if (_ldconfigCache !== undefined) return _ldconfigCache
  try {
    _ldconfigCache = execSync('ldconfig -p', { encoding: 'utf-8', timeout: 3000 })
  } catch {
    _ldconfigCache = ''
  }
  return _ldconfigCache
}

function hasSharedLib(libFragment: string, candidatePaths: string[]): boolean {
  if (candidatePaths.some((p) => existsSync(p))) return true
  return ldconfigOutput().includes(libFragment)
}

let _levelZeroCache: boolean | undefined
/**
 * True when the Intel Level Zero loader is available — the minimum required to
 * run torch+xpu (ComfyUI) and OpenVINO GPU inference on Intel Arc / iGPUs.
 */
export function linuxHasLevelZeroRuntime(): boolean {
  if (_levelZeroCache !== undefined) return _levelZeroCache
  if (process.platform !== 'linux') return (_levelZeroCache = false)
  const found = hasSharedLib('libze_loader.so', [
    '/usr/lib/x86_64-linux-gnu/libze_loader.so.1',
    '/usr/lib/x86_64-linux-gnu/libze_loader.so',
    '/usr/lib/libze_loader.so.1',
    '/usr/lib64/libze_loader.so.1',
    '/usr/local/lib/libze_loader.so.1',
  ])
  appLogger.info(
    `Linux Level Zero runtime ${found ? 'detected' : 'NOT found'} — Intel GPU (XPU) ${found ? 'enabled' : 'disabled'}`,
    'electron-backend',
  )
  return (_levelZeroCache = found)
}

let _vulkanCache: boolean | undefined
/**
 * True when a Vulkan ICD loader is available — used to select the GPU-accelerated
 * llama.cpp build (ubuntu-vulkan-x64) instead of the CPU-only one.
 */
export function linuxHasVulkanLoader(): boolean {
  if (_vulkanCache !== undefined) return _vulkanCache
  if (process.platform !== 'linux') return (_vulkanCache = false)
  const found = hasSharedLib('libvulkan.so', [
    '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
    '/usr/lib/x86_64-linux-gnu/libvulkan.so',
    '/usr/lib/libvulkan.so.1',
    '/usr/lib/libvulkan.so',
    '/usr/lib64/libvulkan.so.1',
    '/usr/local/lib/libvulkan.so.1',
  ])
  appLogger.info(
    `Linux Vulkan loader ${found ? 'detected' : 'NOT found'} — llama.cpp will use the ${found ? 'GPU (ubuntu-vulkan-x64)' : 'CPU-only (ubuntu-x64)'} build`,
    'electron-backend',
  )
  return (_vulkanCache = found)
}


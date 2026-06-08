import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

// Intel PCI vendor ID used in /sys/bus/pci/devices/*/vendor
const INTEL_VENDOR_ID = '0x8086'

/**
 * True when at least one Intel GPU PCI device is present.
 * Checks /sys/bus/pci/devices for vendor=0x8086 with a display/3D class (0x03xxxx).
 * This guards against false positives where libze_loader.so is installed as a
 * dependency on systems that have no Intel GPU hardware at all.
 */
export function linuxHasIntelGpuPciDevice(): boolean {
  try {
    const devices = readdirSync('/sys/bus/pci/devices')
    for (const dev of devices) {
      try {
        const vendor = readFileSync(`/sys/bus/pci/devices/${dev}/vendor`, 'utf-8').trim()
        if (vendor !== INTEL_VENDOR_ID) continue
        const devClass = readFileSync(`/sys/bus/pci/devices/${dev}/class`, 'utf-8').trim()
        // PCI display class: 0x0300xx (VGA), 0x0302xx (3D), 0x0380xx (Other display)
        if (devClass.startsWith('0x03')) return true
      } catch {
        /* unreadable sysfs entry — skip */
      }
    }
  } catch {
    /* /sys/bus/pci not accessible — fall through */
  }
  return false
}

let _levelZeroCache: boolean | undefined

/** Clear the cached Level Zero runtime result (call after installing GPU driver packages). */
export function clearLevelZeroRuntimeCache(): void {
  _levelZeroCache = undefined
}

/**
 * True when:
 *   - the Level Zero ICD loader (`libze_loader.so`) is installed,
 *   - the Intel GPU Level Zero driver (`libze_intel_gpu.so`) is installed, AND
 *   - an Intel GPU PCI device is present.
 *
 * All three are required: the loader alone is insufficient (it can be installed as
 * a transitive dependency with no GPU), and the GPU driver alone doesn't help if
 * the loader isn't there. Checking the hardware avoids false positives where the
 * libraries are present on a non-Intel-GPU machine.
 */
export function linuxHasLevelZeroRuntime(): boolean {
  if (_levelZeroCache !== undefined) return _levelZeroCache
  if (process.platform !== 'linux') return (_levelZeroCache = false)
  const hasLoader = hasSharedLib('libze_loader.so', [
    '/usr/lib/x86_64-linux-gnu/libze_loader.so.1',
    '/usr/lib/x86_64-linux-gnu/libze_loader.so',
    '/usr/lib/libze_loader.so.1',
    '/usr/lib64/libze_loader.so.1',
    '/usr/local/lib/libze_loader.so.1',
  ])
  // The GPU driver (libze_intel_gpu.so) is separate from the loader and can be
  // missing even when the loader is installed (e.g. after a partial package removal).
  // Without it, torch.xpu.device_count() returns 0 and ComfyUI crashes.
  const hasGpuDriver = hasSharedLib('libze_intel_gpu.so', [
    '/usr/lib/x86_64-linux-gnu/libze_intel_gpu.so.1',
    '/usr/lib/x86_64-linux-gnu/libze_intel_gpu.so',
    '/usr/lib/libze_intel_gpu.so.1',
    '/usr/lib64/libze_intel_gpu.so.1',
  ])
  const hasDevice = linuxHasIntelGpuPciDevice()
  const found = hasLoader && hasGpuDriver && hasDevice
  appLogger.info(
    `Linux Level Zero runtime: loader=${hasLoader} gpuDriver=${hasGpuDriver} pciDevice=${hasDevice} → Intel GPU (XPU) ${found ? 'enabled' : 'disabled'}`,
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


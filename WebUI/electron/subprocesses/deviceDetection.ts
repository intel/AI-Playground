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

/**
 * Returns the device list with exactly one device marked `selected`, preferring a
 * previously persisted id when it still exists in the freshly detected list. When
 * the persisted id is absent (or undefined), falls back to `pickDefault` (e.g. the
 * first device, or a priority match). If neither yields a device, no device is
 * marked selected. Used by detectDevices() so a user's GPU choice survives restart.
 */
export function withSelectedDevice<T extends { id: string; selected?: boolean }>(
  devices: T[],
  persistedId: string | undefined,
  pickDefault?: (devices: T[]) => T | undefined,
): T[] {
  const persistedMatch =
    persistedId !== undefined ? devices.find((d) => d.id === persistedId) : undefined
  const target = persistedMatch ?? pickDefault?.(devices)
  return devices.map((d) => ({ ...d, selected: target !== undefined && d.id === target.id }))
}

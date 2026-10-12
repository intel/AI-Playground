/** Developer OEM override set to Acer. Firmware detection does not count. */
export function isAcerVendorOverride(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === 'acer'
}

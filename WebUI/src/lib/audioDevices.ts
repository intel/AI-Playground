/** Chromium hides device ids and labels until microphone access has been granted once. */
export function needsMicrophonePermissionProbe(devices: MediaDeviceInfo[]): boolean {
  const inputs = devices.filter((d) => d.kind === 'audioinput')
  return inputs.length === 0 || inputs.some((d) => !d.deviceId || !d.label)
}

/** Drops the virtual 'default'/'communications' aliases and de-duplicates by device id. */
export function selectAudioInputDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const selected: MediaDeviceInfo[] = []
  const seenIds = new Set<string>()

  for (const device of devices) {
    if (device.kind !== 'audioinput') continue
    if (!device.deviceId || device.deviceId === 'default') continue
    if (device.deviceId === 'communications') continue
    if (seenIds.has(device.deviceId)) continue

    selected.push(device)
    seenIds.add(device.deviceId)
  }

  return selected
}

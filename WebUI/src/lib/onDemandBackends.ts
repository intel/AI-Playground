/** Dedicated TTS/STT sidecars: installed they stay stopped until first use. */
export const ON_DEMAND_BACKENDS = [
  'qwen3-tts-backend',
  'whisper-backend',
] as const satisfies readonly BackendServiceName[]

export function isOnDemandBackend(name: string): boolean {
  return (ON_DEMAND_BACKENDS as readonly string[]).includes(name)
}

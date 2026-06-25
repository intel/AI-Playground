import { useBackendServices, type BackendServiceName } from '@/assets/js/store/backendServices'
import { useTextInference } from '@/assets/js/store/textInference'

export const chatBackends: BackendServiceName[] = ['llamacpp-backend', 'openvino-backend']

/**
 * Free GPU memory used by the chat/LLM model before image generation.
 *
 * For `openvino-backend` we only stop the chat-related sub-servers (LLM +
 * embedding) so the transcription (STT) and speech (TTS) sub-servers keep
 * running. `llamacpp-backend` has no TTS/STT, so a full stop is fine there.
 */
export async function stopChatBackends(): Promise<void> {
  const backendServices = useBackendServices()

  for (const serviceName of chatBackends) {
    const backend = backendServices.info.find((s) => s.serviceName === serviceName)
    try {
      if (serviceName === 'openvino-backend') {
        const result = await window.electronAPI.stopOvmsChatServers()
        if (!result.success) {
          console.warn(`[ComfyUI Tool] Failed to stop OVMS chat servers:`, result.error)
        }
      } else {
        if (backend?.status !== 'running') continue
        await backendServices.stopService(serviceName)
      }
    } catch (error) {
      console.warn(`[ComfyUI Tool] Failed to stop ${serviceName}:`, error)
    }
  }
}

export async function restartChatBackend(): Promise<void> {
  const textInference = useTextInference()
  await textInference.ensureBackendReadiness()
}

import type { BackendServiceName } from '@/assets/js/store/backendServices'
import { useTextInference } from '@/assets/js/store/textInference'

export const chatBackends: BackendServiceName[] = ['llamacpp-backend', 'openvino-backend']

export async function restartChatBackend(): Promise<void> {
  const textInference = useTextInference()
  await textInference.ensureBackendReadiness()
}

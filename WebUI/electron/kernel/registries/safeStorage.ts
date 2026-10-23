import { safeStorage } from 'electron'
import type { SafeStorageInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { LocalSettings } from '../../kernel/localSettings'
import type { appLoggerInstance } from '../../observability/logger'

/**
 * The plaintext opt-in writes the live settings object and main's settings
 * writer; `safeStorage` itself is Electron's own module member.
 */
export type SafeStorageDeps = {
  settings: LocalSettings
  persistLocalSettingsToDisk: () => void
  appLogger: typeof appLoggerInstance
}

export function buildSafeStorageRegistry(deps: SafeStorageDeps) {
  return {
    'safeStorage:isEncryptionAvailable': () => safeStorage.isEncryptionAvailable(),

    'safeStorage:enablePlainTextEncryption': () => {
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          safeStorage.setUsePlainTextEncryption(true)
        }
        if (!safeStorage.isEncryptionAvailable()) {
          return {
            success: false as const,
            error: 'Plaintext secret storage is not available on this system.',
          }
        }
        if (!deps.settings.allowPlaintextSecretStorage) {
          deps.settings.allowPlaintextSecretStorage = true
          deps.persistLocalSettingsToDisk()
        }
        deps.appLogger.warn(
          `User opted into plaintext-backed safeStorage (backend=${safeStorage.getSelectedStorageBackend()}); ` +
            `stored secrets are obfuscated, not encrypted.`,
          'electron-backend',
          true,
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<SafeStorageInvokeName>
}

import { useErrors } from '@/assets/js/store/errors'

/**
 * Shared write-through forwarder for kernel-owned file stores (§6.1, step 8):
 * fire-and-forget, never break the caller's turn on a failed write, and reach
 * the error sink for all three IPC failure shapes — a rejected promise, a
 * resolved `{ success: false }`, and a synchronous throw (Electron structured
 * clone of Vue proxies throws before invoke returns a promise).
 */
export function makeForwardPersist(options: {
  code: string
  technicalMessage: string
}): (call: () => Promise<unknown>) => void {
  const report = (error: unknown): void => {
    useErrors().report(error, {
      code: options.code,
      category: 'backend',
      severity: 'warning',
      surface: 'silent',
      technicalMessage: options.technicalMessage,
    })
  }
  return (call) => {
    try {
      void call()
        .then((result) => {
          if (
            result &&
            typeof result === 'object' &&
            'success' in result &&
            (result as { success: unknown }).success === false
          ) {
            const message =
              'error' in result && typeof (result as { error: unknown }).error === 'string'
                ? (result as { error: string }).error
                : options.technicalMessage
            report(new Error(message))
          }
        })
        .catch(report)
    } catch (error) {
      report(error)
    }
  }
}

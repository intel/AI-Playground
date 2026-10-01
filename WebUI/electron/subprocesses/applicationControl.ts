// libuv does not map Win32 ERROR_VIRUS_INFECTED (4551), so a blocked CreateProcess arrives as spawn + UNKNOWN.
const POLICY_BLOCKED = /application control policy has blocked/i
const OS_ERROR_4551 = /os error 4551/i
const VIRUS_INFECTED = /ERROR_VIRUS_INFECTED/i

export const APPLICATION_CONTROL_USER_MESSAGE =
  'Windows blocked part of this component from running. On Windows 11 this is usually Smart App Control. Turn it off under Windows Security → App & browser control → Smart App Control, then try this step again.'

export type ApplicationControlEvidence = {
  text?: string
  code?: string | null
  syscall?: string | null
  platform?: NodeJS.Platform
}

export function isApplicationControlBlock(evidence: ApplicationControlEvidence): boolean {
  const text = evidence.text ?? ''
  if (POLICY_BLOCKED.test(text) || OS_ERROR_4551.test(text) || VIRUS_INFECTED.test(text)) {
    return true
  }
  const platform = evidence.platform ?? process.platform
  return platform === 'win32' && evidence.code === 'UNKNOWN' && evidence.syscall === 'spawn'
}

export function applicationControlHint(evidence: ApplicationControlEvidence): string | undefined {
  return isApplicationControlBlock(evidence) ? APPLICATION_CONTROL_USER_MESSAGE : undefined
}

export function spawnErrorEvidence(error: unknown): ApplicationControlEvidence {
  if (typeof error === 'object' && error !== null) {
    const err = error as NodeJS.ErrnoException
    return {
      text: error instanceof Error ? error.message : undefined,
      code: typeof err.code === 'string' ? err.code : undefined,
      syscall: typeof err.syscall === 'string' ? err.syscall : undefined,
    }
  }
  return { text: typeof error === 'string' ? error : undefined }
}

export function hintFromError(error: unknown, extraText?: string): string | undefined {
  const evidence = spawnErrorEvidence(error)
  const text = [evidence.text, extraText].filter((part) => part && part.length > 0).join('\n')
  return applicationControlHint({ ...evidence, text })
}

export function withApplicationControlHint<
  T extends { stdout?: string; stderr?: string; hint?: string },
>(details: T): T & { hint?: string } {
  if (details.hint) return details
  const hint = applicationControlHint({
    text: `${details.stdout ?? ''}\n${details.stderr ?? ''}`,
  })
  return hint ? { ...details, hint } : details
}

export function createApplicationControlWatch(): {
  noteText: (text: string) => void
  noteError: (error: unknown) => void
  message: () => string | null
} {
  let blocked = false
  return {
    noteText: (text) => {
      if (isApplicationControlBlock({ text })) blocked = true
    },
    noteError: (error) => {
      if (isApplicationControlBlock(spawnErrorEvidence(error))) blocked = true
    },
    message: () => (blocked ? APPLICATION_CONTROL_USER_MESSAGE : null),
  }
}

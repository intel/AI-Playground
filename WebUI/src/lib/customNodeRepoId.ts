import type { ComfyUICustomNodeRepoId } from '@/types/comfyuiIpc'

// GitHub owner/repo segments and checkout refs. Shell metacharacters, path
// segments `.`/`..`, and a leading `-` (a git checkout option) are rejected.
const SEGMENT = /^[A-Za-z0-9._-]+$/

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && SEGMENT.test(value)
}

export function assertSafeCustomNodeName(
  value: unknown,
  label: 'username' | 'repository name',
): void {
  if (!isSafeSegment(value)) {
    throw new Error(`Invalid custom node ${label}`)
  }
}

export function assertSafeGitRef(gitRef: string | undefined): void {
  if (gitRef === undefined || gitRef === '') return
  if (!isSafeSegment(gitRef) || gitRef.startsWith('-')) {
    throw new Error('Invalid custom node git ref')
  }
}

export function assertSafeCustomNodeRepoId(node: ComfyUICustomNodeRepoId): void {
  if (!node || typeof node !== 'object') {
    throw new Error('Invalid custom node id')
  }
  assertSafeCustomNodeName(node.username, 'username')
  assertSafeCustomNodeName(node.repoName, 'repository name')
  assertSafeGitRef(node.gitRef)
}

/** `owner/repo` or `owner/repo@ref` from a preset's requiredCustomNodes entry. */
export function parseCustomNodeSpec(spec: string): ComfyUICustomNodeRepoId {
  const parts = spec.replace(' ', '').split('@')
  if (parts.length > 2 || parts.length < 1) {
    throw new Error(`Could not extract comfyUI node description from ${spec}`)
  }
  const [repoInfoString, gitRef] = parts
  const repoParts = repoInfoString.replace(' ', '').split('/')
  if (repoParts.length !== 2) {
    throw new Error(`Could not extract comfyUI node description from ${spec}`)
  }
  const [username, repoName] = repoParts
  const id: ComfyUICustomNodeRepoId = { username, repoName, ...(gitRef ? { gitRef } : {}) }
  assertSafeCustomNodeRepoId(id)
  return id
}

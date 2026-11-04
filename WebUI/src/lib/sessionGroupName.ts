import { SESSION_NAME_MAX_LENGTH, type SessionGroup } from '@/types/sessionIpc'

export type GroupNameProblem = 'blank' | 'tooLong' | 'taken'

export type GroupNameCheck = { name: string } | { problem: GroupNameProblem }

/** `ownId` is the Group being renamed, which may keep its own name in another case. */
export function checkGroupName(
  name: string,
  groups: SessionGroup[],
  ownId?: string,
): GroupNameCheck {
  const trimmed = name.trim()
  if (!trimmed) return { problem: 'blank' }
  if (trimmed.length > SESSION_NAME_MAX_LENGTH) return { problem: 'tooLong' }
  const taken = trimmed.toLocaleLowerCase()
  if (groups.some((group) => group.id !== ownId && group.name.toLocaleLowerCase() === taken)) {
    return { problem: 'taken' }
  }
  return { name: trimmed }
}

const REFUSALS: Record<GroupNameProblem, string> = {
  blank: 'A Group needs a name',
  tooLong: 'That Group name is too long',
  taken: 'A Group with that name already exists',
}

export function groupNameRefusal(problem: GroupNameProblem): Error {
  return Object.assign(new Error(REFUSALS[problem]), { groupNameProblem: problem })
}

/** Why a Group name was refused, when that is why the call failed. */
export function groupNameProblemOf(error: unknown): GroupNameProblem | undefined {
  if (!(error instanceof Error) || !('groupNameProblem' in error)) return undefined
  return error.groupNameProblem as GroupNameProblem
}

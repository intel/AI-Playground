import { describe, expect, it } from 'vitest'

import { resolveBuildIdentity, type GitRunner } from '../../../build/scripts/buildIdentity.mts'

const VERSION = '3.2.0-alpha'

/** A git that answers HEAD's hash, and only knows about tags it was given. */
function fakeGit(options: { commit?: string; tagOnHead?: string } = {}): GitRunner {
  return (args) => {
    if (args[0] === 'rev-parse') return options.commit
    if (args[0] === 'describe') return options.tagOnHead
    return undefined
  }
}

describe('resolveBuildIdentity', () => {
  it('names a tag-push installer after the tag, without the leading v', () => {
    const identity = resolveBuildIdentity(
      VERSION,
      { GITHUB_REF: 'refs/tags/v3.2.0-alpha.test8', GITHUB_REF_NAME: 'v3.2.0-alpha.test8' },
      fakeGit({ commit: '8adad7c' }),
    )
    expect(identity).toEqual({
      commit: '8adad7c',
      tag: 'v3.2.0-alpha.test8',
      installerId: '3.2.0-alpha.test8',
    })
  })

  it('names a manual build after the version and commit', () => {
    const identity = resolveBuildIdentity(VERSION, {}, fakeGit({ commit: '8adad7c' }))
    expect(identity).toEqual({
      commit: '8adad7c',
      tag: '',
      installerId: '3.2.0-alpha.8adad7c',
    })
  })

  it('reports a tag on HEAD but still names a manual build after the commit', () => {
    const identity = resolveBuildIdentity(
      VERSION,
      {},
      fakeGit({ commit: '8adad7c', tagOnHead: 'v3.2.0-alpha.test8' }),
    )
    expect(identity.tag).toBe('v3.2.0-alpha.test8')
    expect(identity.installerId).toBe('3.2.0-alpha.8adad7c')
  })

  it('falls back to GITHUB_SHA when git is unavailable', () => {
    const identity = resolveBuildIdentity(
      VERSION,
      { GITHUB_SHA: '8adad7cdeadbeef0000000000000000000000000' },
      fakeGit(),
    )
    expect(identity.commit).toBe('8adad7c')
    expect(identity.installerId).toBe('3.2.0-alpha.8adad7c')
  })

  it('falls back to the bare version when nothing identifies the commit', () => {
    const identity = resolveBuildIdentity(VERSION, {}, fakeGit())
    expect(identity).toEqual({ commit: '', tag: '', installerId: VERSION })
  })

  it('takes the tag from GITHUB_REF when GITHUB_REF_NAME is absent', () => {
    const identity = resolveBuildIdentity(
      VERSION,
      { GITHUB_REF: 'refs/tags/v3.2.0-alpha.test8' },
      fakeGit({ commit: '8adad7c' }),
    )
    expect(identity.tag).toBe('v3.2.0-alpha.test8')
    expect(identity.installerId).toBe('3.2.0-alpha.test8')
  })

  it('ignores a branch ref, which is what a manual run on main has', () => {
    const identity = resolveBuildIdentity(
      VERSION,
      { GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' },
      fakeGit({ commit: '8adad7c' }),
    )
    expect(identity.tag).toBe('')
    expect(identity.installerId).toBe('3.2.0-alpha.8adad7c')
  })
})

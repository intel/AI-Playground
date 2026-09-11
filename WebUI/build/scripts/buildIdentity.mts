/**
 * Which commit a build came from, and what its installer should be called.
 *
 * Two consumers: `vite.config.mts` bakes the commit/tag into the renderer so the
 * footer can show them, and `run-electron-builder.mts` turns them into the
 * `INSTALLER_ID` that `artifactName` expands. Both read the same values so a
 * downloaded installer and the app it installs can never disagree.
 *
 * The package version is never rewritten: it is `app.getVersion()`, which the
 * app also uses as a git ref when fetching remote presets and models.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BuildIdentity = {
  /** Short commit hash, or '' when the source has no git history. */
  commit: string
  /** Release tag pointing at this commit, or '' when there is none. */
  tag: string
  /** Filename component: the release tag, else `<version>.<commit>`. */
  installerId: string
}

type Env = Record<string, string | undefined>

/** Runs a git command, returning its trimmed stdout or undefined on failure. */
export type GitRunner = (args: string[]) => string | undefined

const WEBUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const gitRunner: GitRunner = (args) => {
  try {
    return execFileSync('git', args, {
      cwd: WEBUI_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // No git, no repository (a source zip), or no tag on this commit.
    return undefined
  }
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(WEBUI_ROOT, 'package.json'), 'utf8')) as {
    version?: string
  }
  return pkg.version ?? '0.0.0'
}

/** The tag whose push started this build, '' for any other trigger. */
function pushedTag(env: Env): string {
  if (!env.GITHUB_REF?.startsWith('refs/tags/')) return ''
  return env.GITHUB_REF_NAME ?? env.GITHUB_REF.slice('refs/tags/'.length)
}

function shortCommit(env: Env, runGit: GitRunner): string {
  const fromGit = runGit(['rev-parse', '--short=7', 'HEAD'])
  if (fromGit) return fromGit
  // A CI checkout always has git, but a build from an exported tree does not.
  return env.GITHUB_SHA?.slice(0, 7) ?? ''
}

export function resolveBuildIdentity(
  version = packageVersion(),
  env: Env = process.env,
  runGit: GitRunner = gitRunner,
): BuildIdentity {
  const commit = shortCommit(env, runGit)
  const pushed = pushedTag(env)
  // Without a tag push, HEAD may still carry a tag worth showing in the app.
  const tag = pushed || runGit(['describe', '--tags', '--exact-match']) || ''

  // Only a tag push names the installer after the tag: a manual run of the same
  // commit must stay distinguishable from the release it was cut from.
  const installerId = pushed ? pushed.replace(/^v/, '') : commit ? `${version}.${commit}` : version

  return { commit, tag, installerId }
}

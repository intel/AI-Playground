import path from 'node:path'
import { externalResourcesDir } from '../kernel/aipgRoot.ts'

export const getMediaDir = () => {
  let mediaDir: string
  if (process.env.USERPROFILE) {
    mediaDir = path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'media')
  } else if (process.env.HOME) {
    mediaDir = path.join(process.env.HOME, 'AI-Playground', 'media')
  } else {
    mediaDir = path.join(externalResourcesDir(), 'service', 'static', 'sd_out')
  }
  return mediaDir
}

/**
 * The game library: one folder per game the Game Agent preset produced, sibling to
 * `media/`. The user opens it directly (and the generated hub page lives here), so
 * it goes next to the other user-visible output rather than into app data.
 */
export const getGamesDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'games')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'games')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'games')
}

/** Generated TTS and other agent audio (sibling to `media/`, which holds Comfy output and `input/`). */
export const getAudioDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'audio')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'audio')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'audio')
}

/**
 * The user's chat threads: one JSON file per conversation plus `index.json`
 * (architecture-target §6.1). Sibling to `media/` so a folder copy takes the
 * conversations with it.
 */
export const getConversationsDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'conversations')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'conversations')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'conversations')
}

/**
 * Demo-mode conversations live here instead of the real library and are wiped
 * on exit (§6.1: session-scoped, never a write into the user's real library).
 */
export const getConversationsDemoDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'conversations-demo')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'conversations-demo')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'conversations-demo')
}

/**
 * The user's agent sessions: one JSON file per session record plus
 * `index.json` (architecture-target §6.1). The record carries the renderer
 * transcript; Pi's own session files stay where Pi keeps them.
 */
export const getAgentSessionsDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'agent-sessions')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'agent-sessions')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'agent-sessions')
}

/** Demo-mode agent sessions, wiped on exit like demo conversations (§6.1). */
export const getAgentSessionsDemoDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'agent-sessions-demo')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'agent-sessions-demo')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'agent-sessions-demo')
}

/**
 * Gallery records for generated media (architecture-target §6.1, step 8): one
 * JSON per item plus `index.json`, inside `media/` so a folder copy carries
 * the history beside the files it references.
 */
export const getMediaRecordsDir = () => path.join(getMediaDir(), 'records')

/** Demo-mode gallery records, wiped on exit like demo conversations (§6.1). */
export const getMediaRecordsDemoDir = () => path.join(getMediaDir(), 'records-demo')

/**
 * The user-visible data root every kernel-owned user-data file lives under
 * (architecture-target §6.1). Windows keeps it in Documents so a folder copy
 * carries the library; elsewhere it is directly under the home directory.
 */
function aipgUserDataRoot(): string {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground')
  }
  return path.join(externalResourcesDir(), 'service', 'static')
}

/**
 * The user's preferences (architecture-target §6.1, step 8): what a human
 * would want in a backup — theme, dev toggles, model favorites, voices. One
 * small file with one section per store.
 */
export const getPreferencesFile = () => path.join(aipgUserDataRoot(), 'preferences.json')

/** Demo-mode preferences, wiped on exit like demo conversations (§6.1). */
export const getPreferencesDemoFile = () => getPreferencesFile().replace(/\.json$/, '-demo.json')

/**
 * The RAG document list (architecture-target §6.1, step 8): the indexed
 * document set, full split text included — its own file, not a preference.
 */
export const getRagDocumentsFile = () => path.join(aipgUserDataRoot(), 'rag', 'documents.json')

/** Demo-mode RAG documents, wiped on exit like demo conversations (§6.1). */
export const getRagDocumentsDemoFile = () =>
  path.join(aipgUserDataRoot(), 'rag-demo', 'documents.json')

/**
 * The agent workspace state (architecture-target §6.1, step 8): the last-used
 * workspace pointers — its own file, not a preference.
 */
export const getAgentWorkspaceFile = () => path.join(aipgUserDataRoot(), 'agent-workspace.json')

/** Demo-mode agent workspace state, wiped on exit like demo conversations (§6.1). */
export const getAgentWorkspaceDemoFile = () =>
  getAgentWorkspaceFile().replace(/\.json$/, '-demo.json')

/**
 * Remembered / pre-granted consent decisions (architecture-target §4.7, step 13).
 * Own file, not a preference section: Permissions is request/response, not a
 * renderer store's settings bag.
 */
export const getPermissionGrantsFile = () => path.join(aipgUserDataRoot(), 'permission-grants.json')

/** Demo-mode permission grants, wiped on exit like demo conversations (§6.1). */
export const getPermissionGrantsDemoFile = () =>
  getPermissionGrantsFile().replace(/\.json$/, '-demo.json')

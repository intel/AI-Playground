import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { appLoggerInstance } from '../logging/logger.ts'
import { LOG_SOURCE } from './piAgentLog.ts'

const logger = appLoggerInstance

// Pi appends every message to a JSONL session file and can reopen one with
// `SessionManager.open()`. Surviving an app restart is therefore only a matter
// of remembering which file belongs to which conversation, which is what
// agent-sessions.json holds.

export type SessionPointer = {
  sessionId: string
  workspaceDir: string
  sessionFilePath: string
  updatedAt: number
}

function sessionStorePath(): string {
  return path.join(app.getPath('userData'), 'agent-sessions.json')
}

export function readSessionStore(): Record<string, SessionPointer> {
  try {
    return JSON.parse(fs.readFileSync(sessionStorePath(), 'utf8')) as Record<string, SessionPointer>
  } catch {
    return {}
  }
}

function writeSessionStore(store: Record<string, SessionPointer>): void {
  try {
    fs.writeFileSync(sessionStorePath(), JSON.stringify(store, null, 2))
  } catch (error) {
    logger.warn(`failed to write agent session store: ${error}`, LOG_SOURCE)
  }
}

export function savePointer(pointer: SessionPointer): void {
  const store = readSessionStore()
  store[pointer.sessionId] = pointer
  writeSessionStore(store)
}

export function clearPointer(sessionId: string): void {
  const store = readSessionStore()
  if (sessionId in store) {
    delete store[sessionId]
    writeSessionStore(store)
  }
}

/**
 * The stored session file for this conversation, but only when it belongs to the
 * same workspace and still exists on disk. Anything else means "start fresh".
 */
export function loadSessionFilePath(sessionId: string, workspaceDir: string): string | undefined {
  const pointer = readSessionStore()[sessionId]
  if (!pointer || pointer.workspaceDir !== workspaceDir) return undefined
  if (!pointer.sessionFilePath || !fs.existsSync(pointer.sessionFilePath)) {
    logger.warn(`stored Pi session file missing for ${sessionId}; starting fresh`, LOG_SOURCE)
    return undefined
  }
  return pointer.sessionFilePath
}

/**
 * App-owned Pi config root. Deliberately NOT the developer's `~/.pi`: Pi's
 * resource loader reads global skills and settings from its agent dir, and the
 * app must not pick up whatever a user has configured for their own CLI.
 */
export function piAgentDir(): string {
  const dir = path.join(app.getPath('userData'), 'pi', 'agent')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function piSessionDir(): string {
  const dir = path.join(app.getPath('userData'), 'pi', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

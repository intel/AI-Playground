import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importAttachment } from '../../agentMode/workspaceAttachments.ts'

// Attaching a file to an agent turn copies it into the workspace, so the agent can
// reach it with its own file tools. The name comes from the renderer, so these
// tests are mostly about it not being trusted.

let workspace: string

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-attachments-')))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

const bytes = (text: string) => new Uint8Array(Buffer.from(text))

describe('importAttachment', () => {
  it('saves the file and returns a workspace-relative path', () => {
    const result = importAttachment(workspace, 'player.png', bytes('sprite'))

    expect(result.path).toBe('attachments/player.png')
    expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toBe('sprite')
  })

  it('keeps both files when two share a name', () => {
    const first = importAttachment(workspace, 'sprite.png', bytes('one'))
    const second = importAttachment(workspace, 'sprite.png', bytes('two'))

    expect([first.path, second.path]).toEqual([
      'attachments/sprite.png',
      'attachments/sprite-2.png',
    ])
    expect(fs.readFileSync(path.join(workspace, first.path), 'utf8')).toBe('one')
  })

  it.each([
    ['../../escape.txt', 'escape.txt'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Windows\\evil.exe', 'evil.exe'],
    ['..', 'attachment'],
  ])('strips the path out of %s', (name, expected) => {
    const result = importAttachment(workspace, name, bytes('x'))

    expect(result.path).toBe(`attachments/${expected}`)
    expect(fs.existsSync(path.join(workspace, 'attachments', expected))).toBe(true)
  })

  it('creates the attachments folder on first use', () => {
    expect(fs.existsSync(path.join(workspace, 'attachments'))).toBe(false)

    importAttachment(workspace, 'notes.txt', bytes('hello'))

    expect(fs.existsSync(path.join(workspace, 'attachments'))).toBe(true)
  })
})

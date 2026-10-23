import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isUsableVenv,
  removeBrokenVenv,
  requireUsableVenv,
  venvInterpreterPath,
  venvIsUsable,
} from '../../../adapters/install/uvBasedBackends/venvState'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-state-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('venvInterpreterPath', () => {
  it('points at Scripts/python.exe on Windows and bin/python elsewhere', () => {
    const venvDir = path.join('ComfyUI', '.venv')
    const expected =
      process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python')
    expect(venvInterpreterPath(venvDir)).toBe(expected)
  })
})

describe('venvIsUsable', () => {
  it('is false when the venv directory is missing', () => {
    expect(venvIsUsable(path.join(createTempDir(), 'missing'))).toBe(false)
    expect(isUsableVenv(path.join(createTempDir(), 'missing'))).toBe(false)
  })

  it('is false when the directory exists but the interpreter is missing', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(venvDir)
    expect(venvIsUsable(venvDir)).toBe(false)
  })

  it('is true when the interpreter file exists', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    expect(venvIsUsable(venvDir)).toBe(true)
  })

  it('is false when this account cannot write the venv', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    try {
      expect(venvIsUsable(venvDir)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('is false when pyvenv.cfg home is not readable', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), 'home = /no/such/python-home\n')
    expect(venvIsUsable(venvDir)).toBe(false)
  })

  it('is true when pyvenv.cfg home exists and is readable', () => {
    const root = createTempDir()
    const venvDir = path.join(root, '.venv')
    const home = path.join(root, 'python-home')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.mkdirSync(home)
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), `home = ${home}\n`)
    expect(venvIsUsable(venvDir)).toBe(true)
  })
})

describe('requireUsableVenv', () => {
  it('throws when the interpreter is missing', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(venvDir)
    expect(() => requireUsableVenv(venvDir)).toThrow(venvInterpreterPath(venvDir))
  })

  it('does not throw when the interpreter exists', () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    expect(() => requireUsableVenv(venvDir)).not.toThrow()
  })
})

describe('removeBrokenVenv', () => {
  it('is a no-op when the directory does not exist', async () => {
    const venvDir = path.join(createTempDir(), '.venv')
    expect(await removeBrokenVenv(venvDir)).toBe(false)
    expect(fs.existsSync(venvDir)).toBe(false)
  })

  it('keeps a venv that still has its interpreter', async () => {
    const venvDir = path.join(createTempDir(), '.venv')
    const python = venvInterpreterPath(venvDir)
    fs.mkdirSync(path.dirname(python), { recursive: true })
    fs.writeFileSync(python, '')
    expect(await removeBrokenVenv(venvDir)).toBe(false)
    expect(fs.existsSync(python)).toBe(true)
  })

  it('removes a leftover venv directory with no interpreter', async () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), 'home = leftover')
    expect(await removeBrokenVenv(venvDir)).toBe(true)
    expect(fs.existsSync(venvDir)).toBe(false)
  })

  it('removes a venv whose base Python is not readable', async () => {
    const venvDir = path.join(createTempDir(), '.venv')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), 'home = /no/such/python-home\n')
    expect(await removeBrokenVenv(venvDir)).toBe(true)
    expect(fs.existsSync(venvDir)).toBe(false)
  })

  it('keeps a writable venv whose base Python is readable', async () => {
    const root = createTempDir()
    const venvDir = path.join(root, '.venv')
    const home = path.join(root, 'python-home')
    fs.mkdirSync(path.dirname(venvInterpreterPath(venvDir)), { recursive: true })
    fs.mkdirSync(home)
    fs.writeFileSync(venvInterpreterPath(venvDir), '')
    fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), `home = ${home}\n`)
    expect(await removeBrokenVenv(venvDir)).toBe(false)
    expect(fs.existsSync(venvInterpreterPath(venvDir))).toBe(true)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { cleanupTempFolders, TMP_FOLDER_PATTERN } from '../tempFolderCleanup'

vi.mock('../logging/logger.ts', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('TMP_FOLDER_PATTERN', () => {
  it('matches valid temp folder names', () => {
    expect(TMP_FOLDER_PATTERN.test('fd824df26f56f9a3_tmp')).toBe(true)
    expect(TMP_FOLDER_PATTERN.test('0a1b2c3d4e5f6789_tmp')).toBe(true)
    expect(TMP_FOLDER_PATTERN.test('1234567890abcdef_tmp')).toBe(true)
  })

  it('does not match invalid folder names', () => {
    expect(TMP_FOLDER_PATTERN.test('normal_folder')).toBe(false)
    expect(TMP_FOLDER_PATTERN.test('1234567890abcdef')).toBe(false)
    expect(TMP_FOLDER_PATTERN.test('1234567890abcdef_tmpr')).toBe(false)
    expect(TMP_FOLDER_PATTERN.test('1234abcd_tmp')).toBe(false)
    expect(TMP_FOLDER_PATTERN.test('1234567890ABCDEF_tmp')).toBe(false)
  })
})

describe('cleanupTempFolders', () => {
  describe('with models in path', () => {
    let testDir: string

    beforeEach(() => {
      vi.restoreAllMocks()
      testDir = path.join(tmpdir(), `tmpCleanup-test-${Date.now()}`, 'models')
      mkdirSync(testDir, { recursive: true })
    })

    afterEach(() => {
      const parentDir = path.dirname(testDir)
      if (existsSync(parentDir)) {
        rmSync(parentDir, { recursive: true, force: true })
      }
    })

    it('does nothing when directory does not exist', () => {
      const nonExistent = path.join(testDir, 'nonexistent')
      expect(() => cleanupTempFolders(nonExistent)).not.toThrow()
    })

    it('does nothing when no temp folders exist', async () => {
      const normalDir = path.join(testDir, 'normal_folder')
      mkdirSync(normalDir)

      await cleanupTempFolders(testDir)

      expect(existsSync(normalDir)).toBe(true)
    })

    it('removes temp folders inside models path', async () => {
      const tempFolder = path.join(testDir, 'fd824df26f56f9a3_tmp')
      const nestedDir = path.join(testDir, 'subdir', 'nested')
      const nestedTempFolder = path.join(nestedDir, '0a1b2c3d4e5f6789_tmp')
      const normalFolder = path.join(testDir, 'normal_folder')
      const nestedNormalFolder = path.join(nestedDir, 'normal_nested')

      mkdirSync(tempFolder)
      mkdirSync(nestedDir, { recursive: true })
      mkdirSync(nestedTempFolder)
      mkdirSync(normalFolder)
      mkdirSync(nestedNormalFolder)
      writeFileSync(path.join(tempFolder, 'test.txt'), 'test')

      await cleanupTempFolders(testDir)

      expect(existsSync(tempFolder)).toBe(false)
      expect(existsSync(nestedTempFolder)).toBe(false)
      expect(existsSync(normalFolder)).toBe(true)
      expect(existsSync(nestedNormalFolder)).toBe(true)
      expect(existsSync(nestedDir)).toBe(true)
    })
  })

  describe('without models in path', () => {
    it('does NOT remove temp folders', async () => {
      const nonModelsDir = path.join(tmpdir(), `non-models-path-${Date.now()}`)
      const tempFolder = path.join(nonModelsDir, 'fd824df26f56f9a3_tmp')
      mkdirSync(nonModelsDir, { recursive: true })
      mkdirSync(tempFolder)
      writeFileSync(path.join(tempFolder, 'test.txt'), 'test')

      await cleanupTempFolders(nonModelsDir)

      expect(existsSync(tempFolder)).toBe(true)
      rmSync(nonModelsDir, { recursive: true, force: true })
    })
  })
})

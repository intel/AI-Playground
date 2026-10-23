import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_DOWNLOAD_GRANT, vramWarningGrantKey } from '@/types/permissionsIpc'

const files = vi.hoisted(() => ({ real: '', demo: '' }))
const prompt = vi.hoisted(() => ({
  requestPermissionsPrompt: vi.fn(async (_payload: unknown) => undefined as unknown),
}))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getPermissionGrantsFile: () => files.real,
  getPermissionGrantsDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../permissions/promptAdapter.ts', () => ({
  requestPermissionsPrompt: prompt.requestPermissionsPrompt,
}))

const { grantPermission, resetPermissionGrantsForTest, setPermissionGrantsDeps } =
  await import('../../persist/grantsStore')
const { requestDownloadConsent, requestVramWarningConsent } =
  await import('../../permissions/permissionsService')

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-perm-svc-'))
  files.real = path.join(tmpRoot, 'permission-grants.json')
  files.demo = path.join(tmpRoot, 'permission-grants-demo.json')
  resetPermissionGrantsForTest()
  setPermissionGrantsDeps({ isDemoMode: () => false })
  prompt.requestPermissionsPrompt.mockReset()
})

afterEach(async () => {
  resetPermissionGrantsForTest()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('permissions policy (main)', () => {
  it('asks the adapter for a desktop download when no remote turn is active', async () => {
    prompt.requestPermissionsPrompt.mockImplementation(async (payload: unknown) => {
      if ((payload as { kind: string }).kind === 'is-remote') return false
      return undefined
    })
    const models = [{ repo_id: 'test/model' }]
    await requestDownloadConsent(models)
    const downloadCall = prompt.requestPermissionsPrompt.mock.calls.find(
      ([payload]) => (payload as { kind: string }).kind === 'download',
    )
    expect(downloadCall?.[0]).toMatchObject({
      kind: 'download',
      models,
      skipConfirmation: false,
    })
  })

  it('skips the in-channel question when the remote-download pre-grant exists', async () => {
    await grantPermission(REMOTE_DOWNLOAD_GRANT, 'pre-grant')
    prompt.requestPermissionsPrompt.mockImplementation(async (payload: unknown) => {
      if ((payload as { kind: string }).kind === 'is-remote') return true
      return undefined
    })
    await requestDownloadConsent([{ repo_id: 'test/model' }])
    const downloadCall = prompt.requestPermissionsPrompt.mock.calls.find(
      ([payload]) => (payload as { kind: string }).kind === 'download',
    )
    expect(downloadCall?.[0]).toMatchObject({ skipConfirmation: true })
  })

  it('does not skip confirmation on a remote turn without the pre-grant', async () => {
    prompt.requestPermissionsPrompt.mockImplementation(async (payload: unknown) => {
      if ((payload as { kind: string }).kind === 'is-remote') return true
      return undefined
    })
    await requestDownloadConsent([{ repo_id: 'test/model' }])
    const downloadCall = prompt.requestPermissionsPrompt.mock.calls.find(
      ([payload]) => (payload as { kind: string }).kind === 'download',
    )
    expect(downloadCall?.[0]).toMatchObject({ skipConfirmation: false })
  })

  it('treats a missing window as not-remote, then fails the download prompt', async () => {
    prompt.requestPermissionsPrompt.mockImplementation(async (payload: unknown) => {
      if ((payload as { kind: string }).kind === 'is-remote') throw new Error('No renderer window')
      throw new Error('No renderer window available for the permission prompt')
    })
    await expect(requestDownloadConsent([{ repo_id: 'x' }])).rejects.toThrow('No renderer window')
  })

  it('resolves a VRAM warning without prompting when it was remembered', async () => {
    await grantPermission(vramWarningGrantKey('LTX-Video'), 'remember')
    await expect(
      requestVramWarningConsent({ presetName: 'LTX-Video', message: 'needs lots of VRAM' }),
    ).resolves.toBe(true)
    expect(prompt.requestPermissionsPrompt).not.toHaveBeenCalled()
  })

  it('records a remember grant when the adapter confirms with do-not-show-again', async () => {
    prompt.requestPermissionsPrompt.mockResolvedValueOnce({ confirmed: true, remember: true })
    await expect(
      requestVramWarningConsent({ presetName: 'Wan2.1-VACE', message: 'needs lots of VRAM' }),
    ).resolves.toBe(true)
    const { hasPermissionGrant } = await import('../../persist/grantsStore')
    expect(await hasPermissionGrant(vramWarningGrantKey('Wan2.1-VACE'))).toBe(true)
  })

  it('does not grant when the user cancels the VRAM warning', async () => {
    prompt.requestPermissionsPrompt.mockResolvedValueOnce({ confirmed: false, remember: false })
    await expect(
      requestVramWarningConsent({ presetName: 'LTX-Video', message: 'needs lots of VRAM' }),
    ).resolves.toBe(false)
    const { hasPermissionGrant } = await import('../../persist/grantsStore')
    expect(await hasPermissionGrant(vramWarningGrantKey('LTX-Video'))).toBe(false)
  })
})

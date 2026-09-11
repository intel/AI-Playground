import { describe, it, expect } from 'vitest'
import {
  buildOvmsCandidates,
  parseUbuntuMajor,
  ubuntuDistroTargets,
} from '../../subprocesses/ovmsDownloadUrls'

const STORAGE = 'https://storage.openvinotoolkit.org/repositories/openvino_model_server/packages'

describe('buildOvmsCandidates', () => {
  it('asks for the weekly build by its versioned name first on Windows', () => {
    // The name that failed to install on a Windows test box: a weekly release
    // lives under <version>.<tag>/ and embeds the version in the filename.
    expect(
      buildOvmsCandidates({
        platform: 'win32',
        version: '2026.4.0',
        releaseTag: 'e5e9afa2',
        distros: [],
      }),
    ).toEqual([
      `${STORAGE}/weekly/2026.4.0.e5e9afa2/ovms_windows_2026.4.0_python_on.zip`,
      `${STORAGE}/weekly/2026.4.0.e5e9afa2/ovms_windows_python_on.zip`,
    ])
  })

  it('drops the weekly path from Windows URLs for a stable release', () => {
    expect(buildOvmsCandidates({ platform: 'win32', version: '2026.4.0', distros: [] })).toEqual([
      `${STORAGE}/2026.4.0/ovms_windows_2026.4.0_python_on.zip`,
      `${STORAGE}/2026.4.0/ovms_windows_python_on.zip`,
    ])
  })

  it('exhausts a newer distro before falling back to the older build', () => {
    const candidates = buildOvmsCandidates({
      platform: 'linux',
      version: '2026.4.0',
      releaseTag: 'e5e9afa2',
      distros: ['ubuntu26', 'ubuntu24'],
    })

    const pkg = (distro: string) => `ovms_${distro}_2026.4.0_python_on.tar.gz`
    expect(candidates).toEqual([
      `https://github.com/openvinotoolkit/model_server/releases/download/v2026.4.0/${pkg('ubuntu26')}`,
      `${STORAGE}/weekly/2026.4.0.e5e9afa2/${pkg('ubuntu26')}`,
      `${STORAGE}/2026.4.0/${pkg('ubuntu26')}`,
      `https://github.com/openvinotoolkit/model_server/releases/download/v2026.4.0/${pkg('ubuntu24')}`,
      `${STORAGE}/weekly/2026.4.0.e5e9afa2/${pkg('ubuntu24')}`,
      `${STORAGE}/2026.4.0/${pkg('ubuntu24')}`,
    ])
  })

  it('offers no weekly URL on Linux without a release tag', () => {
    const candidates = buildOvmsCandidates({
      platform: 'linux',
      version: '2026.4.0',
      distros: ['ubuntu24'],
    })

    expect(candidates).toEqual([
      'https://github.com/openvinotoolkit/model_server/releases/download/v2026.4.0/ovms_ubuntu24_2026.4.0_python_on.tar.gz',
      `${STORAGE}/2026.4.0/ovms_ubuntu24_2026.4.0_python_on.tar.gz`,
    ])
  })

  it('treats macOS like Linux, since there is no macOS build to ask for', () => {
    const candidates = buildOvmsCandidates({
      platform: 'darwin',
      version: '2026.4.0',
      distros: ['ubuntu24'],
    })

    expect(candidates.every((url) => url.includes('ubuntu24'))).toBe(true)
  })
})

describe('parseUbuntuMajor', () => {
  it.each([
    ['VERSION_ID="24.04"\n', 24],
    ['VERSION_ID="26.04"\n', 26],
    ['VERSION_ID=26\n', 26],
    ['NAME="Ubuntu"\nVERSION_ID="22.04"\n', 22],
  ])('reads %j as %i', (osRelease, expected) => {
    expect(parseUbuntuMajor(osRelease)).toBe(expected)
  })

  it.each([
    ['unreadable /etc/os-release', undefined],
    ['NAME="Something"\n', ''],
  ])('reports nothing for %s', (_label, osRelease) => {
    expect(parseUbuntuMajor(osRelease as string | undefined)).toBeUndefined()
  })
})

describe('ubuntuDistroTargets', () => {
  it('keeps ubuntu24 as a fallback behind the native build on Ubuntu 26+', () => {
    expect(ubuntuDistroTargets(26)).toEqual(['ubuntu26', 'ubuntu24'])
  })

  it.each([24, 22])('uses the ubuntu24 build on Ubuntu %i', (major) => {
    expect(ubuntuDistroTargets(major)).toEqual(['ubuntu24'])
  })

  it('falls back to ubuntu24 when the host version is unknown', () => {
    expect(ubuntuDistroTargets(undefined)).toEqual(['ubuntu24'])
  })
})

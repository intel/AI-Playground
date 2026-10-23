const STORAGE_BASE_URL =
  'https://storage.openvinotoolkit.org/repositories/openvino_model_server/packages'

export type OvmsCandidateOptions = {
  platform: NodeJS.Platform
  version: string
  releaseTag?: string
  /** Distro build targets in priority order; ignored on Windows. */
  distros: string[]
}

/**
 * Ordered OVMS download URLs, most-specific first.
 *
 * Windows uses the OpenVINO toolkit storage zip. Elsewhere GitHub Releases is
 * canonical and toolkit storage is the fallback, once per distro target so a
 * newer distro's build is preferred over an older compatible one.
 */
export function buildOvmsCandidates({
  platform,
  version,
  releaseTag,
  distros,
}: OvmsCandidateOptions): string[] {
  const versionPath = releaseTag ? `weekly/${version}.${releaseTag}` : version

  if (platform === 'win32') {
    return [
      `${STORAGE_BASE_URL}/${versionPath}/ovms_windows_${version}_python_on.zip`,
      // Legacy non-versioned name, for older storage layouts.
      `${STORAGE_BASE_URL}/${versionPath}/ovms_windows_python_on.zip`,
    ]
  }

  return distros.flatMap((distro) => {
    const pkg = `ovms_${distro}_${version}_python_on.tar.gz`
    return [
      `https://github.com/openvinotoolkit/model_server/releases/download/v${version}/${pkg}`,
      ...(releaseTag ? [`${STORAGE_BASE_URL}/weekly/${version}.${releaseTag}/${pkg}`] : []),
      `${STORAGE_BASE_URL}/${version}/${pkg}`,
    ]
  })
}

/** Major Ubuntu version from /etc/os-release contents, when it states one. */
export function parseUbuntuMajor(osRelease: string | undefined): number | undefined {
  const versionId = osRelease?.match(/^VERSION_ID="?(\d+)(?:\.\d+)?"?/m)?.[1]
  return versionId ? parseInt(versionId, 10) : undefined
}

/**
 * Distro build targets to try, in priority order. Ubuntu 26+ prefers its native
 * build but keeps ubuntu24 as a fallback; everything else, including an
 * undetectable host, gets ubuntu24 as the best effort.
 */
export function ubuntuDistroTargets(ubuntuMajor: number | undefined): string[] {
  return ubuntuMajor !== undefined && ubuntuMajor >= 26 ? ['ubuntu26', 'ubuntu24'] : ['ubuntu24']
}

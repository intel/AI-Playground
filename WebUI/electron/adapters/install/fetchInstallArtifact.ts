import { net } from 'electron'

/**
 * Fetch a backend installer artifact (archive) without touching Chromium's
 * session HTTP cache.
 *
 * `storage.openvinotoolkit.org` answers a missing key with a cacheable
 * `200 text/html` file-browser page instead of a 404. Under the default cache
 * mode Chromium stores that page under the archive's URL and — the page
 * carries no `Cache-Control`, only a years-old `Last-Modified` — serves it as
 * heuristically fresh long after the real archive is published, so every retry
 * keeps seeing HTML. `no-store` neither reads nor writes the cache, which also
 * keeps the multi-hundred-MB archives out of it.
 */
export function fetchInstallArtifact(url: string): ReturnType<typeof net.fetch> {
  return net.fetch(url, { cache: 'no-store' })
}

export type InstallArtifactResponse = Awaited<ReturnType<typeof fetchInstallArtifact>>

export type SkippedArtifact = {
  url: string
  status: number
  contentType: string
  contentLength: string
}

export type InstallArtifactHooks = {
  onAttempt?: (url: string) => void
  onSkip?: (skipped: SkippedArtifact) => void
}

/**
 * Try candidate URLs in order and return the first that answers with an actual
 * archive, or undefined when none does.
 *
 * A missing package is not a 404 on the OpenVINO storage: it answers 200 with
 * the HTML directory listing, which would otherwise be written to disk as the
 * archive and only fail later at extraction.
 */
export async function fetchFirstInstallArtifact(
  urls: string[],
  hooks: InstallArtifactHooks = {},
): Promise<{ url: string; response: InstallArtifactResponse } | undefined> {
  for (const url of urls) {
    hooks.onAttempt?.(url)
    const response = await fetchInstallArtifact(url)
    const contentType = response.headers.get('content-type') ?? ''
    const isArchive =
      response.ok &&
      response.status === 200 &&
      !!response.body &&
      !contentType.includes('text/html')
    if (isArchive) {
      return { url, response }
    }
    hooks.onSkip?.({
      url,
      status: response.status,
      contentType,
      contentLength: response.headers.get('content-length') ?? 'unknown',
    })
  }
  return undefined
}

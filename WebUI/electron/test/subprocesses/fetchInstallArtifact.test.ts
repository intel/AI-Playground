import { describe, it, expect, vi, beforeEach } from 'vitest'
import { net } from 'electron'
import { fetchFirstInstallArtifact } from '../../subprocesses/fetchInstallArtifact'

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn(),
  },
}))

const fetchMock = vi.mocked(net.fetch)

/** The 200 HTML directory listing the OpenVINO storage serves for a missing key. */
function missingPackagePage(): Response {
  return new Response('<!DOCTYPE html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html', 'content-length': '1061' },
  })
}

function archive(): Response {
  return new Response('PK\u0003\u0004', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': '137590715' },
  })
}

/** Answers each URL from a map, so assertions do not depend on call order. */
function serve(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (input) =>
    (routes[String(input)] ?? (() => new Response('', { status: 404 })))(),
  )
}

describe('fetchFirstInstallArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls through an HTML miss page to the candidate that has the archive', async () => {
    const zip = archive()
    serve({
      'https://storage/missing.zip': missingPackagePage,
      'https://storage/real.zip': () => zip,
    })

    const found = await fetchFirstInstallArtifact([
      'https://storage/missing.zip',
      'https://storage/real.zip',
    ])

    // The HTML page is a 200, so only the content-type keeps it from being
    // written to disk as the archive.
    expect(found).toEqual({ url: 'https://storage/real.zip', response: zip })
  })

  it('stops at the first archive instead of trying the rest', async () => {
    serve({ 'https://storage/real.zip': archive, 'https://storage/other.zip': archive })

    await fetchFirstInstallArtifact(['https://storage/real.zip', 'https://storage/other.zip'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://storage/real.zip', expect.anything())
  })

  it('skips error statuses and bodyless responses', async () => {
    const zip = archive()
    serve({
      'https://storage/forbidden.zip': () => new Response('nope', { status: 403 }),
      'https://storage/empty.zip': () => new Response(null, { status: 200 }),
      'https://storage/real.zip': () => zip,
    })

    const found = await fetchFirstInstallArtifact([
      'https://storage/forbidden.zip',
      'https://storage/empty.zip',
      'https://storage/real.zip',
    ])

    expect(found?.url).toBe('https://storage/real.zip')
  })

  it('reports no artifact when every candidate is a miss page', async () => {
    serve({
      'https://storage/a.zip': missingPackagePage,
      'https://storage/b.zip': missingPackagePage,
    })

    const found = await fetchFirstInstallArtifact([
      'https://storage/a.zip',
      'https://storage/b.zip',
    ])

    // The caller turns this into the "no valid download URL" setup failure
    // rather than unzipping an HTML page.
    expect(found).toBeUndefined()
  })

  it('describes each skipped candidate for the install log', async () => {
    serve({
      'https://storage/missing.zip': missingPackagePage,
      'https://storage/real.zip': archive,
    })
    const attempts: string[] = []
    const skips: unknown[] = []

    await fetchFirstInstallArtifact(['https://storage/missing.zip', 'https://storage/real.zip'], {
      onAttempt: (url) => attempts.push(url),
      onSkip: (skipped) => skips.push(skipped),
    })

    expect(attempts).toEqual(['https://storage/missing.zip', 'https://storage/real.zip'])
    expect(skips).toEqual([
      {
        url: 'https://storage/missing.zip',
        status: 200,
        contentType: 'text/html',
        contentLength: '1061',
      },
    ])
  })

  it('requests candidates with the HTTP cache bypassed', async () => {
    serve({ 'https://storage/real.zip': archive })

    await fetchFirstInstallArtifact(['https://storage/real.zip'])

    // Without `no-store` a once-cached miss page is replayed for this URL and
    // no retry can ever see the archive that was published since.
    expect(fetchMock).toHaveBeenCalledWith('https://storage/real.zip', { cache: 'no-store' })
  })
})

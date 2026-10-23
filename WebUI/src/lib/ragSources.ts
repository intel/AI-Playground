import { PHISON_KM_RAG_PREFIX } from '@/types/phisonKmRag'

export type RagSourceDocument = {
  pageContent?: string
  metadata?: {
    source?: string
    loc?: {
      pageNumber?: number
      lines?: {
        from?: number
        to?: number
      }
    }
  }
}

export function augmentSystemPrompt(
  basePrompt: string,
  pageContents: string[],
  useGroupRetrieval: boolean,
): string {
  if (pageContents.length === 0) return basePrompt
  const ragContext = pageContents.join('\n\n')
  return useGroupRetrieval
    ? `${PHISON_KM_RAG_PREFIX}\n\nDocument context:\n\n${ragContext}\n\n---\n\n${basePrompt}`
    : `${basePrompt}\n\nUse the following context from your knowledge base to answer the question:\n\n${ragContext}`
}

export function formatRagSources(documents: RagSourceDocument[]): string {
  const fileGroups = new Map<
    string,
    Array<{
      lines?: { from: number; to: number }
      page?: number
    }>
  >()
  const unknownSources: string[] = []

  documents.forEach((doc) => {
    const source = doc.metadata?.source
    const location = doc.metadata?.loc

    if (!source) {
      unknownSources.push('Unknown Source')
      return
    }

    const entries = fileGroups.get(source) || []
    const entry: { lines?: { from: number; to: number }; page?: number } = {}

    if (location?.lines?.from && location?.lines?.to) {
      entry.lines = {
        from: location.lines.from,
        to: location.lines.to,
      }
    }

    if (location?.pageNumber !== undefined) {
      entry.page = location.pageNumber
    }

    // Phison KM group retrieval returns a merged document with `source` but no
    // `loc` (the group spans many chunks); the Source Docs chip still needs the filename.
    entries.push(entry)
    fileGroups.set(source, entries)
  })

  const mergeRanges = (
    entries: Array<{ lines?: { from: number; to: number }; page?: number }>,
  ): Array<{ lines?: { from: number; to: number }; page?: number }> => {
    if (entries.length <= 1) return entries

    const pageGroups = new Map<
      number | undefined,
      Array<{ lines?: { from: number; to: number }; page?: number }>
    >()

    entries.forEach((entry) => {
      const pageKey = entry.page
      const pageEntries = pageGroups.get(pageKey) || []
      pageEntries.push(entry)
      pageGroups.set(pageKey, pageEntries)
    })

    const result: Array<{ lines?: { from: number; to: number }; page?: number }> = []

    pageGroups.forEach((pageEntries, pageNumber) => {
      const entriesWithLines = pageEntries.filter((e) => e.lines)

      if (entriesWithLines.length > 0) {
        const sortedEntries = [...entriesWithLines].sort(
          (a, b) => (a.lines?.from || 0) - (b.lines?.from || 0),
        )

        let current = sortedEntries[0]

        for (let i = 1; i < sortedEntries.length; i++) {
          const next = sortedEntries[i]

          if ((current.lines?.to || 0) >= (next.lines?.from || 0) - 1) {
            current = {
              lines: {
                from: current.lines?.from || 0,
                to: Math.max(current.lines?.to || 0, next.lines?.to || 0),
              },
              page: pageNumber,
            }
          } else {
            result.push(current)
            current = next
          }
        }

        result.push(current)
      }

      if (pageEntries.some((e) => !e.lines)) {
        if (!result.some((r) => r.page === pageNumber && !r.lines)) {
          result.push({ page: pageNumber })
        }
      }
    })

    return result
  }

  const formattedResults: string[] = []

  fileGroups.forEach((entries, source) => {
    const filename = source.split(/[\/\\]/).pop() || source
    const mergedEntries = mergeRanges(entries)

    mergedEntries.forEach((entry) => {
      let locationInfo = ''

      if (entry.page !== undefined && entry.lines) {
        locationInfo = `Page ${entry.page}, Lines ${entry.lines.from}-${entry.lines.to}`
      } else if (entry.page !== undefined) {
        locationInfo = `Page ${entry.page}`
      } else if (entry.lines) {
        locationInfo = `Lines ${entry.lines.from}-${entry.lines.to}`
      }

      formattedResults.push(locationInfo ? `${filename} (${locationInfo})` : filename)
    })
  })

  formattedResults.push(...unknownSources)

  return formattedResults.join('\n')
}

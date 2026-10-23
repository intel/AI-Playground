import fs from 'node:fs'

import {
  GGUF_EOF_MESSAGE,
  parseGgufMetadata,
  type GgufMetadata,
  type GgufReader,
} from '@/lib/vram/gguf'

/** `limit` bounds how far into the file the parser may look, in bytes. */
export function fileGgufReader(
  path: string,
  options?: { limit?: number },
): { reader: GgufReader; close: () => void } {
  const fd = fs.openSync(path, 'r')
  let pos = 0
  return {
    reader: {
      read(n) {
        if (options?.limit !== undefined && pos + n > options.limit) {
          throw new Error(GGUF_EOF_MESSAGE)
        }
        const buf = Buffer.allocUnsafe(n)
        let got = 0
        while (got < n) {
          const read = fs.readSync(fd, buf, got, n - got, pos)
          if (read === 0) throw new Error(GGUF_EOF_MESSAGE)
          pos += read
          got += read
        }
        return buf.subarray(0, n)
      },
      skip(n) {
        pos += n
      },
    },
    close: () => fs.closeSync(fd),
  }
}

export function readGgufMetadataFromFile(
  path: string,
  options?: { limit?: number; allowTruncated?: boolean },
): GgufMetadata {
  const { reader, close } = fileGgufReader(path, { limit: options?.limit })
  try {
    return parseGgufMetadata(reader, { allowTruncated: options?.allowTruncated })
  } finally {
    close()
  }
}

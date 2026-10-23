export type GgufScalar = number | string | boolean | number[] | boolean[]

export type GgufMetadata = {
  version: number
  tensorCount: number
  architecture?: string
  vocabSize?: number
  values: Map<string, GgufScalar>
  /** The bytes ran out mid-header; `values` holds what was read up to there. */
  truncated?: boolean
}

export type GgufReader = {
  read(n: number): Uint8Array
  skip(n: number): void
}

const GGUF_MAGIC = 0x46554747
export const GGUF_EOF_MESSAGE = 'Unexpected EOF in GGUF header'

/** Whether a read failed for want of bytes rather than because the file is wrong. */
export function isGgufTruncation(error: unknown): boolean {
  return error instanceof Error && error.message === GGUF_EOF_MESSAGE
}

const TYPE_SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
}

export const GgufType = {
  Uint8: 0,
  Int8: 1,
  Uint16: 2,
  Int16: 3,
  Uint32: 4,
  Int32: 5,
  Float32: 6,
  Bool: 7,
  String: 8,
  Array: 9,
  Uint64: 10,
  Int64: 11,
  Float64: 12,
} as const

export function bytesReader(bytes: Uint8Array): GgufReader {
  let offset = 0
  return {
    read(n) {
      if (offset + n > bytes.length) {
        throw new Error(GGUF_EOF_MESSAGE)
      }
      const slice = bytes.subarray(offset, offset + n)
      offset += n
      return slice
    },
    skip(n) {
      if (offset + n > bytes.length) {
        throw new Error(GGUF_EOF_MESSAGE)
      }
      offset += n
    },
  }
}

/**
 * `allowTruncated` stops at the byte the reader ran out on and marks the result,
 * instead of throwing: a header's `<arch>.*` keys precede the tokenizer's, so a
 * partial read is often already everything the estimator asks for.
 */
export function parseGgufMetadata(
  reader: GgufReader,
  options?: { allowTruncated?: boolean },
): GgufMetadata {
  const magic = readU32(reader)
  if (magic !== GGUF_MAGIC) {
    throw new Error('Not a GGUF file')
  }
  const version = readU32(reader)
  if (version < 2) {
    throw new Error(`Unsupported GGUF version ${version}`)
  }
  const tensorCount = readU64(reader)
  const kvCount = readU64(reader)
  const values = new Map<string, GgufScalar>()
  let vocabSize: number | undefined
  let architecture: string | undefined

  let truncated = false
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = readString(reader)
      const vtype = readU32(reader)
      if (key === 'tokenizer.ggml.tokens' && vtype === GgufType.Array) {
        const atype = readU32(reader)
        const alen = readU64(reader)
        vocabSize = alen
        skipArrayBody(reader, atype, alen)
        continue
      }
      const value = readValue(reader, vtype)
      if (value === undefined) continue
      values.set(key, value)
      if (key === 'general.architecture' && typeof value === 'string') {
        architecture = value
      }
    }
  } catch (error) {
    if (!options?.allowTruncated || !isGgufTruncation(error)) throw error
    truncated = true
  }

  const vocabFromKey = numberValue(values, architecture ? `${architecture}.vocab_size` : undefined)
  return {
    version,
    tensorCount,
    architecture,
    vocabSize: vocabFromKey ?? vocabSize,
    values,
    truncated,
  }
}

export function parseGgufMetadataBytes(bytes: Uint8Array): GgufMetadata {
  return parseGgufMetadata(bytesReader(bytes))
}

export type EncodeValue =
  | { type: 'u32' | 'u64' | 'i32'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'u32[]'; value: number[] }
  | { type: 'bool[]'; value: boolean[] }
  | { type: 'string[]'; value: string[] }

/** Minimal GGUF (no tensors) for tests and round-trips. */
export function encodeGgufMetadata(
  pairs: Iterable<[string, EncodeValue]>,
  options?: { tensorCount?: number; version?: number },
): Uint8Array {
  const entries = [...pairs]
  const chunks: Uint8Array[] = []
  const header = new ArrayBuffer(24)
  const view = new DataView(header)
  view.setUint32(0, GGUF_MAGIC, true)
  view.setUint32(4, options?.version ?? 3, true)
  view.setBigUint64(8, BigInt(options?.tensorCount ?? 0), true)
  view.setBigUint64(16, BigInt(entries.length), true)
  chunks.push(new Uint8Array(header))
  for (const [key, value] of entries) {
    chunks.push(encodeString(key), encodeTypedValue(value))
  }
  return concat(chunks)
}

function readValue(reader: GgufReader, vtype: number): GgufScalar | undefined {
  switch (vtype) {
    case GgufType.Uint8:
      return reader.read(1)[0] ?? 0
    case GgufType.Int8:
      return new DataView(copyBuffer(reader.read(1))).getInt8(0)
    case GgufType.Uint16:
      return readU16(reader)
    case GgufType.Int16:
      return new DataView(copyBuffer(reader.read(2))).getInt16(0, true)
    case GgufType.Uint32:
      return readU32(reader)
    case GgufType.Int32:
      return new DataView(copyBuffer(reader.read(4))).getInt32(0, true)
    case GgufType.Float32:
      return new DataView(copyBuffer(reader.read(4))).getFloat32(0, true)
    case GgufType.Bool:
      return reader.read(1)[0] !== 0
    case GgufType.String:
      return readString(reader)
    case GgufType.Array:
      return readArray(reader)
    case GgufType.Uint64:
      return readU64(reader)
    case GgufType.Int64:
      return Number(new DataView(copyBuffer(reader.read(8))).getBigInt64(0, true))
    case GgufType.Float64:
      return new DataView(copyBuffer(reader.read(8))).getFloat64(0, true)
    default:
      throw new Error(`Unknown GGUF value type ${vtype}`)
  }
}

function readArray(reader: GgufReader): GgufScalar | undefined {
  const atype = readU32(reader)
  const alen = readU64(reader)
  if (atype === GgufType.Bool) {
    const out: boolean[] = []
    for (let i = 0; i < alen; i++) out.push(reader.read(1)[0] !== 0)
    return out
  }
  if (atype === GgufType.Uint32 || atype === GgufType.Int32) {
    const out: number[] = []
    for (let i = 0; i < alen; i++) {
      out.push(atype === GgufType.Uint32 ? readU32(reader) : (readValue(reader, atype) as number))
    }
    return out
  }
  skipArrayBody(reader, atype, alen)
  return undefined
}

function skipValue(reader: GgufReader, vtype: number): void {
  const size = TYPE_SIZE[vtype]
  if (size !== undefined) {
    reader.skip(size)
    return
  }
  if (vtype === GgufType.String) {
    reader.skip(readU64(reader))
    return
  }
  if (vtype === GgufType.Array) {
    const atype = readU32(reader)
    const alen = readU64(reader)
    skipArrayBody(reader, atype, alen)
    return
  }
  throw new Error(`Unknown GGUF value type ${vtype}`)
}

function skipArrayBody(reader: GgufReader, atype: number, alen: number): void {
  const elemSize = TYPE_SIZE[atype]
  if (elemSize !== undefined) {
    reader.skip(elemSize * alen)
    return
  }
  if (atype === GgufType.String) {
    for (let i = 0; i < alen; i++) reader.skip(readU64(reader))
    return
  }
  for (let i = 0; i < alen; i++) skipValue(reader, atype)
}

function readU16(reader: GgufReader): number {
  return new DataView(copyBuffer(reader.read(2))).getUint16(0, true)
}

function readU32(reader: GgufReader): number {
  return new DataView(copyBuffer(reader.read(4))).getUint32(0, true)
}

function readU64(reader: GgufReader): number {
  const value = new DataView(copyBuffer(reader.read(8))).getBigUint64(0, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('GGUF integer exceeds Number.MAX_SAFE_INTEGER')
  }
  return Number(value)
}

function readString(reader: GgufReader): string {
  const len = readU64(reader)
  return new TextDecoder().decode(reader.read(len))
}

function numberValue(values: Map<string, GgufScalar>, key: string | undefined): number | undefined {
  if (!key) return undefined
  const value = values.get(key)
  return typeof value === 'number' ? value : undefined
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function encodeString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  const out = new Uint8Array(8 + encoded.length)
  new DataView(out.buffer).setBigUint64(0, BigInt(encoded.length), true)
  out.set(encoded, 8)
  return out
}

function encodeTypedValue(value: EncodeValue): Uint8Array {
  switch (value.type) {
    case 'u32':
      return concat([u32(GgufType.Uint32), u32(value.value)])
    case 'i32':
      return concat([u32(GgufType.Int32), i32(value.value)])
    case 'u64':
      return concat([u32(GgufType.Uint64), u64(value.value)])
    case 'string':
      return concat([u32(GgufType.String), encodeString(value.value)])
    case 'bool':
      return concat([u32(GgufType.Bool), Uint8Array.of(value.value ? 1 : 0)])
    case 'u32[]': {
      const body = new Uint8Array(4 + 8 + value.value.length * 4)
      const view = new DataView(body.buffer)
      view.setUint32(0, GgufType.Uint32, true)
      view.setBigUint64(4, BigInt(value.value.length), true)
      value.value.forEach((n, i) => view.setUint32(12 + i * 4, n, true))
      return concat([u32(GgufType.Array), body])
    }
    case 'bool[]': {
      const body = new Uint8Array(4 + 8 + value.value.length)
      const view = new DataView(body.buffer)
      view.setUint32(0, GgufType.Bool, true)
      view.setBigUint64(4, BigInt(value.value.length), true)
      value.value.forEach((bit, i) => {
        body[12 + i] = bit ? 1 : 0
      })
      return concat([u32(GgufType.Array), body])
    }
    case 'string[]': {
      const strings = value.value.map(encodeString)
      const body = concat([u32(GgufType.String), u64(value.value.length), ...strings])
      return concat([u32(GgufType.Array), body])
    }
  }
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

function i32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, n, true)
  return out
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

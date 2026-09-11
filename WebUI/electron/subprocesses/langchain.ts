import { OpenAIEmbeddings } from '@langchain/openai'
import { CacheBackedEmbeddings } from '@langchain/classic/embeddings/cache_backed'
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory'
import { LocalFileStore } from 'langchain/storage/file_system'

import { TextLoader } from '@langchain/classic/document_loaders/fs/text'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { Document } from '@langchain/classic/document'

// PDFs are parsed with unpdf's worker-free pdf.js build. langchain's own PDFLoader
// (backed by pdf-parse v2) is unusable in this Electron utility process: pdf-parse
// detects `process.type === 'utility'` as a browser-like Electron context and takes
// a browser worker path (blob-URL `import()`, `window.location`) that can't run here.
import { extractText } from 'unpdf'

import { RecursiveCharacterTextSplitter } from '@langchain/classic/text_splitter'

import type {
  IndexedDocument,
  EmbedInquiry,
  MergedGroup,
  MergedGroupsMeta,
  WarmupRequest,
  PhisonKmIngestConfig,
} from '@/assets/js/store/textInference.ts'
import {
  buildMergedGroups,
  stampGroupIds,
  ensureMergedGroups,
  selectGroupContext,
  warmupKVCache,
  type SplitterParams,
} from './langchainPhisonKm.ts'

import { createHash, randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import fs from 'fs'

/** OpenAI SDK v6+ rejects empty-string apiKey; local embedding servers ignore this value. */
const LOCAL_COMPAT_OPENAI_API_KEY = process.env.AIPG_LOCAL_OPENAI_API_KEY?.trim() || randomUUID()

/**
 * Splitter parameters for the general RAG chunking strategy (used for every
 * document, Phison KM or not). Also doubles as the fingerprint Phison KM uses to
 * detect a stale/incompatible grouping — see groupsAreValid in langchainPhisonKm.ts.
 */
const SPLITTER_PARAMS: SplitterParams = { chunkSize: 512, chunkOverlap: 64 }

let documentEmbeddingStore: LocalFileStore

type AddDocumentArgs = {
  document: IndexedDocument
  phisonKmConfig?: PhisonKmIngestConfig
}

process.parentPort.on('message', async (message) => {
  console.log('message received in langchain utility process', message)
  const type = message.data.type
  switch (type) {
    case 'init':
      console.log('Initializing Langchain process')
      // ensure that path exists
      if (!fs.existsSync(message.data.embeddingCachePath)) {
        fs.mkdirSync(message.data.embeddingCachePath, { recursive: true })
      }

      documentEmbeddingStore = new LocalFileStore({
        rootPath: message.data.embeddingCachePath,
      })
      console.log('Langchain process initialized')
      break

    case 'addDocumentToRAGList':
      process.parentPort.postMessage({
        type,
        returnValue: await addDocumentToRAGList(message.data.args as AddDocumentArgs),
      })
      break

    case 'embedInputUsingRag':
      process.parentPort.postMessage({
        type,
        returnValue: await embedInputUsingRag(message.data.args as EmbedInquiry),
      })
      break

    case 'warmupKVCacheForDocument':
      await warmupKVCache(message.data.args as WarmupRequest)
      process.parentPort.postMessage({ type, returnValue: { success: true } })
      break
  }
})

setInterval(() => {}, 10000)

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

async function addDocumentToRAGList(args: AddDocumentArgs): Promise<IndexedDocument> {
  const { document, phisonKmConfig } = args
  console.log(
    `[addDocumentToRAGList] file: ${document.filename}, phisonKmConfig: ${phisonKmConfig ? `present (url: ${phisonKmConfig.embeddingServerUrl})` : 'absent'}`,
  )

  const rawDocument = await loadDocument(document.type, document.filepath)
  console.log(rawDocument)

  const splitter = new RecursiveCharacterTextSplitter(SPLITTER_PARAMS)
  const splitDocument = await splitter.splitDocuments(rawDocument)

  // Computed before grouping because Phison KM keys each groupId on the document's
  // content hash (see buildMergedGroup in langchainPhisonKm.ts).
  const hash = await generateFileSHA256Hash(document.filepath)

  let mergedGroups: MergedGroup[] | undefined
  let mergedGroupsMeta: MergedGroupsMeta | undefined
  if (phisonKmConfig?.embeddingServerUrl) {
    const built = await buildMergedGroups(
      splitDocument,
      phisonKmConfig.embeddingServerUrl,
      SPLITTER_PARAMS,
      hash,
    )
    mergedGroups = built.groups
    mergedGroupsMeta = built.meta
    stampGroupIds(splitDocument, mergedGroups)
    console.log(
      `Phison KM: created ${mergedGroups.length} merged group(s) for ${document.filename}`,
    )
  }

  return {
    ...document,
    splitDB: splitDocument,
    mergedGroups,
    mergedGroupsMeta,
    hash,
  }
}

async function loadDocument(type: string, filepath: string): Promise<Document[]> {
  switch (type) {
    case 'md':
    case 'txt':
      return await new TextLoader(filepath).load()
    case 'doc':
      return await new DocxLoader(filepath, { type: 'doc' }).load()
    case 'docx':
      return await new DocxLoader(filepath).load()
    case 'pdf':
      return await loadPdf(filepath)
    default:
      console.error('Invalid document type')
      throw new Error('Invalid document type')
  }
}

async function loadPdf(filepath: string): Promise<Document[]> {
  const buffer = await readFile(filepath)
  // extractText resolves the PDF via getDocumentProxy internally (same Node font/cMap
  // defaults) and destroys the loading task when done, so we don't hold a proxy ourselves.
  const { totalPages, text } = await extractText(new Uint8Array(buffer), { mergePages: false })
  return text
    .map(
      (pageText, index) =>
        new Document({
          pageContent: pageText,
          metadata: { source: filepath, pdf: { totalPages }, loc: { pageNumber: index + 1 } },
        }),
    )
    .filter((doc) => doc.pageContent.trim().length > 0)
}

async function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<Document[]> {
  console.log('embedInputUsingRag', embedInquiry)

  const model = embedInquiry.embeddingModel.split('/').join('---')
  const baseURL = `${embedInquiry.backendBaseUrl}/v1`

  // Phison KM: ensure every doc has merged groups before retrieval. Scoped strictly
  // to useGroupRetrieval — the standard path below is untouched by KM and must keep
  // matching origin/dev's retrieval algorithm for every non-Phison user (OpenVINO/NPU,
  // non-Phison llama.cpp). See aidaptiv-km-rag-review-scope.md §W1-4.
  if (embedInquiry.useGroupRetrieval) {
    await ensureMergedGroups(embedInquiry.ragList, embedInquiry.backendBaseUrl, SPLITTER_PARAMS)
  }

  const underlyingEmbeddings = new OpenAIEmbeddings({
    verbose: true,
    openAIApiKey: LOCAL_COMPAT_OPENAI_API_KEY,
    model,
    configuration: {
      baseURL,
    },
  })

  const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
    underlyingEmbeddings,
    documentEmbeddingStore,
    { namespace: createHash('sha256').update(underlyingEmbeddings.model).digest('hex') },
  )

  if (embedInquiry.useGroupRetrieval) {
    return embedInputUsingRagPhisonKm(embedInquiry, cacheBackedEmbeddings)
  }

  return embedInputUsingRagStandard(embedInquiry, cacheBackedEmbeddings)
}

/**
 * Phison KM path: per-document retrieval — fetch perDocResults from each document
 * independently, then merge. With multiple documents, a single shared top-K search
 * (the standard path below) can let superficially similar chunks from one document
 * outcompete relevant chunks from another; per-document retrieval guarantees every
 * document contributes to the result set. This trade-off is intentionally scoped to
 * KM only, since it changes ranking/recall behavior relative to the standard path.
 */
async function embedInputUsingRagPhisonKm(
  embedInquiry: EmbedInquiry,
  cacheBackedEmbeddings: CacheBackedEmbeddings,
): Promise<Document[]> {
  const perDocResults = embedInquiry.perDocResults ?? 2

  const perDocHits: [Document, number][] = []
  for (const ragDoc of embedInquiry.ragList) {
    if (!ragDoc.splitDB || ragDoc.splitDB.length === 0) continue
    const docStore = await MemoryVectorStore.fromDocuments(ragDoc.splitDB, cacheBackedEmbeddings)
    const hits = await docStore.similaritySearchWithScore(embedInquiry.prompt, perDocResults)
    perDocHits.push(...hits)
  }

  // De-duplicate by pageContent and sort by descending score.
  const seen = new Set<string>()
  const result = perDocHits
    .sort(([, a], [, b]) => b - a)
    .filter(([doc]) => {
      const key = doc.pageContent
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  console.log(
    `Per-doc retrieval: ${result.length} unique results across ${embedInquiry.ragList.length} doc(s):`,
    result.map(
      ([doc, score]) =>
        `${doc.metadata.source}@${JSON.stringify(doc.metadata.loc)}: Score ${score}`,
    ),
  )

  const filtered = result.filter(([_doc, score]) => score > 0.5)
  return selectGroupContext(filtered, embedInquiry.ragList)
}

/**
 * Standard path — must stay byte-for-byte equivalent to origin/dev's
 * embedInputUsingRag: a single shared vector store across all checked documents,
 * top maxResults by similarity. Every non-Phison user (OpenVINO/NPU, non-Phison
 * llama.cpp) goes through this branch, so Phison-specific changes must never leak
 * in here — they belong in embedInputUsingRagPhisonKm above.
 */
async function embedInputUsingRagStandard(
  embedInquiry: EmbedInquiry,
  cacheBackedEmbeddings: CacheBackedEmbeddings,
): Promise<Document[]> {
  const maxResults = embedInquiry.maxResults ?? 6

  const vectorStore = await MemoryVectorStore.fromDocuments(
    embedInquiry.ragList.flatMap((doc) => doc.splitDB),
    cacheBackedEmbeddings,
  )

  const result = await vectorStore.similaritySearchWithScore(embedInquiry.prompt, maxResults)

  console.log(
    `Got ${result.length} results:`,
    result.map(
      ([doc, score]) =>
        `${doc.metadata.source}@${JSON.stringify(doc.metadata.loc)}: Score ${score}`,
    ),
  )

  return result.filter(([_doc, score]) => score > 0.5).map(([doc, _score]) => doc)
}

async function generateFileSHA256Hash(filePath: string): Promise<string> {
  try {
    const fileBuffer = await readFile(filePath)
    const hashSum = createHash('sha256')
    hashSum.update(fileBuffer)
    const hex = hashSum.digest('hex')
    return hex
  } catch (error) {
    console.error('Error generating file hash:', error)
    throw error
  }
}

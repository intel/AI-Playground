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

import { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

import { createHash, randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import fs from 'fs'

/** OpenAI SDK v6+ rejects empty-string apiKey; local embedding servers ignore this value. */
const LOCAL_COMPAT_OPENAI_API_KEY = process.env.AIPG_LOCAL_OPENAI_API_KEY?.trim() || randomUUID()

let documentEmbeddingStore: LocalFileStore

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
        returnValue: await addDocumentToRAGList(message.data.args),
      })
      break
    case 'embedInputUsingRag':
      process.parentPort.postMessage({
        type,
        returnValue: await embedInputUsingRag(message.data.args),
      })
      break
  }
})

setInterval(() => {}, 10000)

async function addDocumentToRAGList(document: IndexedDocument): Promise<IndexedDocument> {
  console.log(document)
  const rawDocument = await loadDocument(document.type, document.filepath)
  console.log(rawDocument)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 512,
    chunkOverlap: 64,
  })
  const splitDocument = await splitter.splitDocuments(rawDocument)
  const newDocument = {
    ...document,
    splitDB: splitDocument,
    hash: await generateFileSHA256Hash(document.filepath),
  }
  return newDocument
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
  const maxResults = embedInquiry.maxResults ?? 6

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

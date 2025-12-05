import { OpenAIEmbeddings } from '@langchain/openai'
import { CacheBackedEmbeddings } from 'langchain/embeddings/cache_backed'
import { MemoryVectorStore } from 'langchain/vectorstores/memory'
import { LocalFileStore } from 'langchain/storage/file_system'

import { TextLoader } from 'langchain/document_loaders/fs/text'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import { Document } from 'langchain/document'

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'

import { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import fs from 'fs'

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
  //try {

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
    hash: await generateFileMD5Hash(document.filepath),
  }
  return newDocument
  // } catch (error) {
  //   console.error('Failed to add document to RAG list')
  //   throw new Error('Failed to add document to RAG list')
  // }
}

async function loadDocument(type: string, filepath: string) {
  let loader: TextLoader | DocxLoader | PDFLoader
  switch (type) {
    case 'md':
    case 'txt': {
      loader = new TextLoader(filepath)
      break
    }
    case 'doc': {
      loader = new DocxLoader(filepath, { type: 'doc' })
      break
    }
    case 'docx': {
      loader = new DocxLoader(filepath)
      break
    }
    case 'pdf': {
      loader = new PDFLoader(filepath)
      break
    }
    default: {
      console.error('Invalid document type')
      throw new Error('Invalid document type')
    }
  }
  return await loader.load()
}

async function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<Document[]> {
  console.log('embedInputUsingRag', embedInquiry)

  const model = embedInquiry.embeddingModel.split('/').join('---')
  const baseURL = `${embedInquiry.backendBaseUrl}/v1`
  const maxResults = embedInquiry.maxResults ?? 6

  const underlyingEmbeddings = new OpenAIEmbeddings({
    verbose: true,
    openAIApiKey: '',
    model,
    configuration: {
      baseURL,
    },
  })

  const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
    underlyingEmbeddings,
    documentEmbeddingStore,
    { namespace: createHash('md5').update(underlyingEmbeddings.model).digest('hex') },
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

async function generateFileMD5Hash(filePath: string): Promise<string> {
  try {
    const fileBuffer = await readFile(filePath)
    const hashSum = createHash('md5')
    hashSum.update(fileBuffer)
    const hex = hashSum.digest('hex')
    return hex
  } catch (error) {
    console.error('Error generating file hash:', error)
    throw error
  }
}

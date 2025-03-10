import { OpenAIEmbeddings } from '@langchain/openai'
import { CacheBackedEmbeddings } from 'langchain/embeddings/cache_backed'
import { MemoryVectorStore } from 'langchain/vectorstores/memory'
import { InMemoryStore } from 'langchain/storage/in_memory'

import { TextLoader } from 'langchain/document_loaders/fs/text'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import { Document } from 'langchain/document'

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'

import { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

import { createHash } from 'crypto'
import { readFile } from 'fs/promises'

process.parentPort.once('message', (message) => {
  if (message.data === 'start') {
    console.log('Langchain utility process started')
    process.parentPort.postMessage('Utility process started')
  }
})

process.parentPort.on('message', async (message) => {
  console.log(message)
  if (message.data.type === 'addDocumentToRAGList') {
    process.parentPort.postMessage({
      type: 'addDocumentToRAGList',
      returnValue: await addDocumentToRAGList(message.data.args),
    })
  }
  if (message.data.type === 'embedInputUsingRag') {
    process.parentPort.postMessage({
      type: 'embedInputUsingRag',
      returnValue: await embedInputUsingRag(message.data.args),
    })
  }
})

setInterval(() => {}, 10000)

async function addDocumentToRAGList(document: IndexedDocument): Promise<IndexedDocument> {
  //try {

  console.log(document)
  const rawDocument = await loadDocument(document.type, document.filepath)
  console.log(rawDocument)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1600,
    chunkOverlap: 400,
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

async function loadDocument(
  type: string,
  filepath: string,
): Promise<Document<Record<string, any>>[]> {
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

async function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<KVObject> {
  const underlyingEmbeddings = new OpenAIEmbeddings({
    openAIApiKey: '',
    configuration: {
      baseURL: embedInquiry.backendBaseUrl, // Your custom endpoint based on the backend, load for backend
    },
  })

  // // Initialize cache-backed embeddings with in-memory cache
  // const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
  //   underlyingEmbeddings,
  //   new InMemoryStore(), // shall be initialized with start of the app
  //   { namespace: underlyingEmbeddings.model }, // default atm, change
  // )

  // let vectorStore = null
  // for (let indexedDocument of embedInquiry.ragList) {
  //   vectorStore = await MemoryVectorStore.fromDocuments(
  //     indexedDocument.splitDB,
  //     cacheBackedEmbeddings,
  //   ) // check again and add to vector store rather than create one
  // }

  // vectorStore?.similaritySearchWithScore(embedInquiry.prompt, 0.5)
  // // do similarity search
  // // save the used documents in store
  // // return the result

  return {}
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

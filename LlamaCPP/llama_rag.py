import gc
import json
import os
import re
import time
from typing import Any, List, Dict

from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.embeddings import LlamaCppEmbeddings
from langchain_community.document_loaders.markdown import UnstructuredMarkdownLoader
from langchain_community.document_loaders.pdf import PyPDFLoader
from langchain_community.document_loaders.text import TextLoader
from langchain_community.document_loaders.word_document import (
    UnstructuredWordDocumentLoader,
    Docx2txtLoader,
)
from langchain_community.vectorstores.faiss import FAISS, Document

#### CONFIGURATIONS ------------------------------------------------------------------------------------------------------------------------
INDEX_DATABASE_PATH = "./db/"  # Faiss database folder
CHUNK_SIZE = 1600  # Chunk size for text splitter
CHUNK_OVERLAP = 400  # Chunk overlap for text splitter
INDEX_NUM = 2  # Number of content pieces to retrieve
MAX_NEW_TOKENS = 320  # Max length of LLM output


# Embedding model class - create a wrapper for embedding model
class EmbeddingWrapper:
    def __init__(self, model_path: str):
        start = time.time()
        print(f"******* loading {model_path} start ")
        self.model = LlamaCppEmbeddings(model_path=model_path)
        print(
            "******* loading {} finish. cost {:3f}s".format(
                model_path, time.time() - start
            )
        )

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        t0 = time.time()
        embeddings = self.model.embed_documents(texts)
        t1 = time.time()
        print("-----------LlamaCpp--embedding cost time(s): ", t1 - t0)
        return embeddings

    def embed_query(self, text: str) -> List[float]:
        return self.model.embed_query(text)


# Faiss database - manage embeddings and file indexing
class EmbeddingDatabase:
    db: FAISS
    embeddings: EmbeddingWrapper
    text_splitter: RecursiveCharacterTextSplitter
    index_list: List[Dict[str, Any]]

    def __init__(self, embeddings: EmbeddingWrapper):
        self.embeddings = embeddings
        index_cache = os.path.join(INDEX_DATABASE_PATH, "index.faiss")
        self.db = (
            FAISS.load_local(INDEX_DATABASE_PATH, self.embeddings)
            if os.path.exists(index_cache)
            else None
        )
        index_json = os.path.join(INDEX_DATABASE_PATH, "index.json")
        self.index_list = (
            self.__load_exists_index(index_json)
            if os.path.exists(index_json)
            else list()
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, length_function=len
        )

    def __load_exists_index(self, index_json: str):
        try:
            with open(index_json, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"load index.json error: {e}")
            return list()

    def __save_index(self, file_base_name: str, md5: str, doc_ids: str):
        self.index_list.append({"name": file_base_name, "md5": md5, "doc_ids": doc_ids})
        if not os.path.exists(INDEX_DATABASE_PATH):
            os.makedirs(INDEX_DATABASE_PATH)
        index_json = os.path.join(INDEX_DATABASE_PATH, "index.json")
        with open(index_json, "w") as f:
            json.dump(self.index_list, f)
        self.db.save_local(INDEX_DATABASE_PATH)

    def __add_documents(self, file_base_name: str, docs: List[Document], md5: str):
        if self.db is None:
            self.db = FAISS.from_documents(docs, self.embeddings)
        else:
            self.db.add_documents(docs)
        print(docs[0].metadata)
        self.__save_index(file_base_name, md5, [doc.metadata["doc_id"] for doc in docs])

    def __analyze_file_to_db(self, file: str, md5: str):
        file_base_name = os.path.basename(file)
        file_ext = os.path.splitext(file_base_name)[1].lower()

        if file_ext == ".txt":
            raw_documents = TextLoader(file, encoding="utf-8").load()
        elif file_ext == ".pdf":
            raw_documents = PyPDFLoader(file).load()
        elif file_ext == ".doc":
            raw_documents = UnstructuredWordDocumentLoader(file).load()
        elif file_ext == ".docx":
            raw_documents = Docx2txtLoader(file).load()
        elif file_ext == ".md":
            raw_documents = UnstructuredMarkdownLoader(file).load()
        else:
            raise Exception(f"Unsupported file extension {file_ext}")

        docs = self.text_splitter.split_documents(raw_documents)
        if docs:
            print("Analyze {} got {} index files.".format(file_base_name, len(docs)))
            self.__add_documents(file_base_name, docs, md5)
        else:
            raise Exception(f"Cannot analyze {file_base_name}")

    def add_index_file(self, file: str):
        md5 = self.__calculate_md5(file)
        for item in self.index_list:
            if item["md5"] == md5:
                print(f"{os.path.basename(file)} already indexed.")
                return 1, md5

        self.__analyze_file_to_db(file, md5)
        return 0, md5

    def query_database(self, query: str):
        if not query:
            raise Exception("Query cannot be None or empty")

        print("******* Querying database...")
        if self.db is None:
            return False, None, None

        docs = self.db.similarity_search_with_relevance_scores(
            query, k=INDEX_NUM, score_threshold=0.4
        )
        if not docs:
            return False, None, None

        doc_contents = [doc.page_content for doc, _ in docs]
        source_files = {doc.metadata["source"] for doc, _ in docs}
        return True, "\n\n".join(doc_contents), "\n".join(source_files)

    def __calculate_md5(self, file_path: str) -> str:
        import hashlib

        hasher = hashlib.md5()
        with open(file_path, "rb") as f:
            buf = f.read()
            hasher.update(buf)
        return hasher.hexdigest()


def init(model_path: str):
    global embedding_database, embedding_wrapper
    embedding_wrapper = EmbeddingWrapper(model_path=model_path)
    embedding_database = EmbeddingDatabase(embedding_wrapper)


def add_index_file(file: str):
    return embedding_database.add_index_file(file)


def query(query: str):
    return embedding_database.query_database(query)


def dispose():
    global embedding_database, embedding_wrapper
    embedding_database = None
    embedding_wrapper = None
    gc.collect()


if __name__ == "__main__":
    # Example Usage
    init(model_path="/Users/daniel/silicon/AI-Playground/LlamaCPP/models/llm/gguf/bge-large-en-v1.5-q8_0.gguf")
    add_index_file("/Users/daniel/silicon/AI-Playground/hello.txt")
    success, context, source = query("What is the content about?")
    print("Query success:", success)
    print("Context:", context)
    print("Source Files:", source)
    dispose()

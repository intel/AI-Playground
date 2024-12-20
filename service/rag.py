import gc
import json
import os
import re
import time
from typing import Any, List, Dict

# from sentence_transformers import SentenceTransformer
import intel_extension_for_pytorch as ipex  # noqa: F401
import torch
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.document_loaders.markdown import UnstructuredMarkdownLoader
from langchain_community.document_loaders.pdf import PyPDFLoader
from langchain_community.document_loaders.text import TextLoader
from langchain_community.document_loaders.word_document import (
    UnstructuredWordDocumentLoader,
    Docx2txtLoader,
)
from langchain_community.vectorstores.faiss import FAISS, Document
from langchain_core.embeddings import Embeddings
from sentence_transformers import SentenceTransformer

import aipg_utils as utils
import service_config

#### CONFIGURATIONS ------------------------------------------------------------------------------------------------------------------------
INDEX_DATABASE_PATH = "./db/"  # Faiss database folder
CHUNK_SIZE = 1600  # Chunk size for text spliter
CHUNK_OVERLAP = 400  # Chunk overlap for text spliter
INDEX_NUM = 2  # How many pieces of content to index from db
MAX_NEW_TOKENS = 320  # Max length of LLM output


# Embedding model class - create a wrapper of embedding model, interface open to DB class to create embeddings
class EmbeddingWrapper(Embeddings):
    def __init__(self, repo_id: str):
        model_embd_path = os.path.join(
            service_config.service_model_paths.get("embedding"), repo_id.replace("/", "---")
        )
        start = time.time()
        print(f"******* loading {model_embd_path} start ")
        self.model = SentenceTransformer(
            model_embd_path, trust_remote_code=True, device=service_config.device
        )

        print(
            "******* loading {} finish. cost{:3f}".format(
                model_embd_path, time.time() - start
            )
        )

    def to(self, device: str):
        self.model.to(device)

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        torch.xpu.synchronize()
        t0 = time.time()
        embeddings = [
            self.model.encode(text, normalize_embeddings=True) for text in texts
        ]
        # Convert embeddings from NumPy arrays to lists for serialization
        embeddings_as_lists = [embedding.tolist() for embedding in embeddings]
        torch.xpu.synchronize()
        t1 = time.time()
        print("-----------SentenceTransformer--embedding cost time(s): ", t1 - t0)
        return embeddings_as_lists

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]


# Faiss database - initiate with embedding model wrapper, create database for input file(pdf), return pieces to match new query
class EmbeddingDatabase:
    db: FAISS
    embeddings: EmbeddingWrapper
    text_splitter: RecursiveCharacterTextSplitter
    index_list: List[Dict[str, Any]]

    def __init__(self, embeddings: EmbeddingWrapper):
        self.embeddings = embeddings
        index_cache = os.path.join(INDEX_DATABASE_PATH, "index.faiss")
        self.db = (
            FAISS.load_local(
                INDEX_DATABASE_PATH,
                self.embeddings,
                allow_dangerous_deserialization=True,
            )
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
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
            length_function=len,
            is_separator_regex=False,
        )

    def to(self, device: str):
        self.embeddings.to(device)

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
            docs_ids = list()
            for key in self.db.index_to_docstore_id:
                docs_ids.append(self.db.index_to_docstore_id[key])
        else:
            docs_ids = self.db.add_documents(docs)
        self.__save_index(file_base_name, md5, docs_ids)

    def __analyze_file_to_db(self, file: str, md5: str):
        if not os.path.exists(INDEX_DATABASE_PATH):
            os.makedirs(INDEX_DATABASE_PATH)

        file_base_name = os.path.basename(file)
        file_ext = os.path.splitext(file_base_name)[1].lower()
        if file_ext == ".txt":
            # Load TXT and split into embeded pieces
            raw_documents = TextLoader(file, encoding="utf-8").load()
        elif file_ext == ".pdf":
            # Load PDF and split into embeded pieces
            raw_documents = PyPDFLoader(file).load()
        elif file_ext == ".doc":
            # Load WORD doc and split into embeded pieces
            raw_documents = UnstructuredWordDocumentLoader(file).load()
        elif file_ext == ".docx":
            # Load WORD doxc and split into embeded pieces
            raw_documents = Docx2txtLoader(file).load()
        elif file_ext == ".md":
            # Load markdown and split into embeded pieces
            raw_documents = UnstructuredMarkdownLoader(
                file, mode="elements", strategy="fast"
            ).load()  # UnstructuredFileLoader
        else:
            raise Exception(f"unsupported file ext {file_ext}")

        docs = self.text_splitter.split_documents(raw_documents)

        # Embedding the splitted pieces of text
        if docs is not None:
            print("anayze {} got index file {}".format(file_base_name, docs.__len__()))
            self.__add_documents(file_base_name, docs, md5)
        else:
            raise Exception("can't not anayze {} ".format(file_base_name))

    def add_index_file(self, file: str):
        md5 = utils.calculate_md5(file)
        for item in self.index_list:
            if item["md5"] == md5:
                base_name = os.path.basename(file)
                print(f"{base_name} index {md5} eixsts")
                return 1, md5

        self.__analyze_file_to_db(file, md5)
        return 0, md5

    def query_database(self, query: str):
        if query is None or query == "":
            raise Exception("query can't be None or Empty")

        print("******* query from database ++ ")
        if self.db is None:
            return False, None, None
        docs = self.db.similarity_search_with_relevance_scores(
            query, k=2, score_threshold=0.4
        )
        if docs.__len__() == 0:
            return False, None, None
        # print("------------docs: ", docs[:2])
        doc_contents = list()
        source_set = set()
        for doc, _ in docs[:INDEX_NUM]:
            print("{}  --- {}", _, doc.page_content)
            doc_contents.append(doc.page_content)
            source_set.add(os.path.basename(doc.metadata["source"]))
        context = "\n\n".join(doc_contents)
        source_file = "\n\n".join(source_set)
        return True, context, source_file  # , page_num

    def delete_index(self, md5: str):
        del_index = None
        for index in self.index_list:
            if index.get("md5") == md5:
                del_index = index
                break
        if del_index is not None:
            self.index_list.remove(del_index)
            if self.index_list.__len__() > 0:
                if not os.path.exists(INDEX_DATABASE_PATH):
                    os.makedirs(INDEX_DATABASE_PATH)
                index_json = os.path.join(INDEX_DATABASE_PATH, "index.json")
                with open(index_json, "w") as f:
                    json.dump(self.index_list, f)
                self.db.delete(del_index["doc_ids"])
                self.db.save_local(INDEX_DATABASE_PATH)
            else:
                index_json = os.path.join(INDEX_DATABASE_PATH, "index.json")
                if os.path.exists(index_json):
                    os.remove(index_json)
                index_faiss = os.path.join(INDEX_DATABASE_PATH, "index.faiss")
                if os.path.exists(index_faiss):
                    os.remove(index_faiss)
                index_pkl = os.path.join(INDEX_DATABASE_PATH, "index.pkl")
                if os.path.exists(index_pkl):
                    os.remove(index_pkl)


def add_index_file(file: str):
    global embedding_database
    if re.search(".(txt|docx?|pptx?|md|pdf)$", file, re.IGNORECASE) is not None:
        torch.xpu.synchronize()
        start = time.time()
        result = embedding_database.add_index_file(file)
        torch.xpu.synchronize()
        end = time.time()
        print(f"add index file cost {end-start}s")
    else:
        raise Exception("not suppported file type")
    return result


def to(device: str):
    global embedding_database
    embedding_database.to(device)


def query(query: str):
    global embedding_database
    torch.xpu.synchronize()
    start = time.time()
    success, context, source_file = embedding_database.query_database(query)
    end = time.time()
    print(f'query by keyword "{query}" cost {end-start}s')
    torch.xpu.synchronize()
    return success, context, source_file


def delete_index(md5: str):
    global embedding_database
    embedding_database.delete_index(md5)


def get_index_list():
    global embedding_database
    return embedding_database.index_list


embedding_wrapper: EmbeddingWrapper = None
embedding_database: EmbeddingDatabase = None
Is_Inited = False


def init(repo_id: str, device: int):
    global embedding_database, embedding_wrapper, Is_Inited
    torch.xpu.set_device(device)
    service_config.device = f"xpu:{device}"
    embedding_wrapper = EmbeddingWrapper(repo_id)
    embedding_database = EmbeddingDatabase(embedding_wrapper)
    Is_Inited = True


def dispose():
    global embedding_database, embedding_wrapper, Is_Inited
    if Is_Inited:
        if embedding_wrapper is not None:
            del embedding_wrapper
            embedding_wrapper = None
        if embedding_database is not None:
            del embedding_database
            embedding_database = None
        Is_Inited = False
    gc.collect()
    torch.xpu.empty_cache()

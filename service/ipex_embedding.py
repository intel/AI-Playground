import gc
import json
import os
import re
import time
from typing import Any, List, Dict

# from sentence_transformers import SentenceTransformer
import intel_extension_for_pytorch as ipex  # noqa: F401
import torch
from langchain_core.embeddings import Embeddings
from sentence_transformers import SentenceTransformer
import service_config


class IpexEmbeddingModel(Embeddings):
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
        self.embedding_model_path = model_embd_path

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
    
    def get_embedding(self, text: str):
        return self.embed_query(text)
import gc
import os
import time
from typing import List, Optional

import torch
from langchain_core.embeddings import Embeddings
from sentence_transformers import SentenceTransformer
import config
import utils

class IpexEmbeddingModel(Embeddings):
    _instance = None
    
    @classmethod
    def get_instance(cls, repo_id: Optional[str] = None):
        """
        Get a singleton instance of the embedding model.
        If an instance already exists, return it.
        If repo_id is provided, create a new instance with that model.
        """
        if cls._instance is None and repo_id is not None:
            cls._instance = cls(repo_id)
        return cls._instance
    
    def __init__(self, repo_id: str):
        """
        Initialize the embedding model class but don't load the model yet.
        The model will be loaded on-demand when needed.
        """
        self.repo_id = repo_id
        self.model = None
        self.embedding_model_path = None
        
    def _load_model(self):
        """
        Dynamically load the model when needed.
        """
        if self.model is not None:
            return
            
        model_base_path = utils.get_model_path(5, "default")  # 5 is the type for embedding models
        model_embd_path = os.path.join(
            model_base_path, self.repo_id.replace("/", "---")
        )
        
        start = time.time()
        print(f"******* loading {model_embd_path} start ")
        self.model = SentenceTransformer(
            model_embd_path, trust_remote_code=True, device=config.device
        )
        
        print(
            "******* loading {} finish. cost {:3f}s".format(
                model_embd_path, time.time() - start
            )
        )
        self.embedding_model_path = model_embd_path

    def _unload_model(self):
        """
        Unload the model to free up VRAM.
        """
        if self.model is not None:
            del self.model
            self.model = None
            gc.collect()
            torch.xpu.empty_cache()
            print("******* unloaded embedding model to free VRAM")

    def to(self, device: str):
        """
        Move the model to the specified device.
        """
        self._load_model()
        self.model.to(device)

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """
        Embed a list of documents.
        Loads the model if not already loaded, then unloads it after use.
        """
        try:
            self._load_model()
            
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
        finally:
            # Unload the model after use to free up VRAM
            self._unload_model()

    def embed_query(self, text: str) -> List[float]:
        """
        Embed a single query.
        """
        return self.embed_documents([text])[0]

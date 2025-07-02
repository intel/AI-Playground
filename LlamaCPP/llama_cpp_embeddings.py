import os
from typing import List, Optional

import requests

import utils


class LlamaCppEmbeddingModel:
    """LlamaCPP embedding model implementation using llama-server."""
    
    # Class constants
    DEFAULT_PORT = "39250"
    DEFAULT_REPO_ID = "ChristianAzinn/bge-small-en-v1.5-gguf"
    HEALTH_CHECK_TIMEOUT = 1
    
    _instance = None

    @classmethod
    def get_instance(cls, repo_id: Optional[str] = None) -> Optional['LlamaCppEmbeddingModel']:
        """Get singleton instance of the embedding model.
        
        Args:
            repo_id: Repository ID for the model
            
        Returns:
            Singleton instance or None if not initialized
        """
        if cls._instance is None and repo_id is not None:
            cls._instance = cls(repo_id)
        return cls._instance

    def __init__(self, repo_id: str = DEFAULT_REPO_ID):
        """Initialize the LlamaCPP embedding model.
        
        Args:
            repo_id: Repository ID for the embedding model
        """
        self.repo_id = repo_id
        self.port = int(os.environ.get("LLAMA_EMBEDDING_PORT", self.DEFAULT_PORT))
        self.server_url = f"http://localhost:{self.port}/embedding"
        
        print(f"LlamaCPP embedding client initialized for port {self.port}")

    def _post_to_server(self, input_texts: List[str]) -> List[List[float]]:
        """Send texts to the embedding server and get embeddings.
        
        Args:
            input_texts: List of texts to embed
            
        Returns:
            List of embedding vectors
            
        Raises:
            RuntimeError: If request to server fails
        """
        try:
            response = requests.post(
                self.server_url, 
                json={"input": input_texts},
                timeout=self.HEALTH_CHECK_TIMEOUT * 10  # Longer timeout for embeddings
            )
            response.raise_for_status()
            json_data = response.json()
            return [item["embedding"] for item in json_data]
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to fetch embeddings from llama-server: {e}")

    def embed_query(self, text: str) -> List[float]:
        """Embed a single query text.
        
        Args:
            text: Text to embed
            
        Returns:
            Embedding vector as list of floats
        """
        embeddings = self._post_to_server([text])
        return embeddings[0] if embeddings else []

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Embed multiple documents.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors
        """
        return self._post_to_server(texts)

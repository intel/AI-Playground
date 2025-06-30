import os
import socket
import subprocess
import time
from os import path
from typing import List, Optional

import requests

import utils


class LlamaCppEmbeddingModel:
    """LlamaCPP embedding model implementation using llama-server."""
    
    # Class constants
    DEFAULT_PORT = "39250"
    DEFAULT_REPO_ID = "ChristianAzinn/bge-small-en-v1.5-gguf"
    SERVER_STARTUP_TIMEOUT = 30
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
        self.model_path: Optional[str] = None
        self.port = int(os.environ.get("LLAMA_EMBEDDING_PORT", self.DEFAULT_PORT))
        self.server_url = f"http://localhost:{self.port}/embedding"
        self.executable_path = path.normpath(path.join("llama-cpp-rest", "llama-server.exe"))
        self.server_process: Optional[subprocess.Popen] = None
        
        # Initialize model
        self._resolve_model_path()
        self._start_llama_server()

    def _resolve_model_path(self) -> None:
        """Resolve the model path from repository ID.
        
        Raises:
            FileNotFoundError: If no GGUF files found in model directory
        """
        if self.model_path is not None:
            return

        model_base_path = utils.get_model_path(5, "llama_cpp")
        model_dir = path.normpath(path.join(
            '../service',
            model_base_path,
            utils.repo_local_root_dir_name(self.repo_id),
            utils.extract_model_id_pathsegments(self.repo_id)
        ))

        gguf_files = [f for f in os.listdir(model_dir) if f.endswith('.gguf')]
        if not gguf_files:
            raise FileNotFoundError(f"No GGUF files found in {model_dir}")

        self.model_path = path.normpath(path.join(model_dir, gguf_files[0]))

    def _is_port_open(self, port: int) -> bool:
        """Check if a port is open and available.
        
        Args:
            port: Port number to check
            
        Returns:
            True if port is open, False otherwise
        """
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("localhost", port)) == 0

    def _start_llama_server(self) -> None:
        """Start the llama-server subprocess for embeddings.
        
        Raises:
            RuntimeError: If server fails to start within timeout
        """
        if self._is_port_open(self.port):
            print(f"LlamaCPP embedding server already running on port {self.port}")
            return

        command = [
            self.executable_path,
            "--embedding",
            "--model", self.model_path,
            "--port", str(self.port)
        ]

        print(f"Starting llama-server for embeddings: {' '.join(command)}")
        self.server_process = subprocess.Popen(
            command, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE
        )

        # Wait for server readiness
        self._wait_for_server_ready()

    def _wait_for_server_ready(self) -> None:
        """Wait for the llama server to be ready for requests.
        
        Raises:
            RuntimeError: If server doesn't start within timeout
        """
        for attempt in range(self.SERVER_STARTUP_TIMEOUT):
            if self._is_port_open(self.port):
                print("LlamaCPP embedding server is ready")
                return
            time.sleep(1)

        raise RuntimeError(
            f"LlamaCPP embedding server failed to start within {self.SERVER_STARTUP_TIMEOUT} seconds"
        )

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

    def cleanup(self) -> None:
        """Clean up server resources."""
        if self.server_process:
            try:
                self.server_process.terminate()
                self.server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print("Force killing llama-server embedding process")
                self.server_process.kill()
                self.server_process.wait()
            finally:
                self.server_process = None

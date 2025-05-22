import os
import requests
import subprocess
import time
import socket
from typing import List, Optional

import utils

class LlamaCppEmbeddingModel:
    _instance = None

    @classmethod
    def get_instance(cls, repo_id: Optional[str] = None):
        if cls._instance is None and repo_id is not None:
            cls._instance = cls(repo_id)
        return cls._instance

    def __init__(self, repo_id: str = "ChristianAzinn/bge-small-en-v1.5-gguf"):
        self.repo_id = repo_id
        self.model_path = None
        self.port = 5006
        self.server_url = f"http://localhost:{self.port}/embedding"
        self.executable_path = os.path.normpath(os.path.join("llama-cpp-rest", "llama-server.exe"))
        self.server_process = None
        self._resolve_model_path()
        self._start_llama_server()

    def _resolve_model_path(self):
        if self.model_path is not None:
            return

        model_base_path = utils.get_model_path(5, "llama_cpp")
        model_dir = os.path.normpath(os.path.join(
            '../service',
            model_base_path,
            utils.repo_local_root_dir_name(self.repo_id),
            utils.extract_model_id_pathsegments(self.repo_id)
        ))

        gguf_files = [f for f in os.listdir(model_dir) if f.endswith('.gguf')]
        if not gguf_files:
            raise FileNotFoundError(f"No GGUF files found in {model_dir}")

        self.model_path = os.path.normpath(os.path.join(model_dir, gguf_files[0]))

    def _is_port_open(self, port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("localhost", port)) == 0

    def _start_llama_server(self):
        if self._is_port_open(self.port):
            print(f"llama-server already running on port {self.port}")
            return

        command = [
            self.executable_path,
            "--embedding",
            "--model", self.model_path,
            "--port", str(self.port)
        ]

        print(f"Starting llama-server for embeddings: {' '.join(command)}")
        self.server_process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Wait for server readiness
        for _ in range(30):
            if self._is_port_open(self.port):
                print("llama-server (embedding) is ready.")
                return
            time.sleep(1)

        raise RuntimeError("llama-server (embedding) did not start in time.")

    def _post_to_server(self, input_texts: List[str]) -> List[List[float]]:
        try:
            response = requests.post(self.server_url, json={"input": input_texts})
            response.raise_for_status()
            json_data = response.json()
            return [item["embedding"] for item in json_data]
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to fetch embeddings from llama-server: {e}")

    def embed_query(self, text: str) -> List[float]:
        embeddings = self._post_to_server([text])
        return embeddings[0] if embeddings else []

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return self._post_to_server(texts)

import gc
import json
import os
import subprocess
import time
from os import path
from typing import Callable, Dict, Iterator, List, Optional

import requests

import config
from interface import LLMInterface
from params import LLMParams


class LlamaCpp(LLMInterface):
    """LlamaCPP backend implementation for LLM inference using llama-server."""
    
    # Class constants
    DEFAULT_PORT = "39150"
    DEFAULT_CONTEXT_LENGTH = 2048
    DEFAULT_MAX_TOKENS = 1024
    DEFAULT_GPU_LAYERS = 999
    SERVER_STARTUP_TIMEOUT = 30
    HEALTH_CHECK_TIMEOUT = 1
    
    # Default stop sequences
    DEFAULT_STOP_SEQUENCES = ["\nUser:", "User:", "\n###", "</s>"]

    def __init__(self):
        """Initialize the LlamaCPP backend."""
        self._model = None  
        self.stop_generate = False
        self._last_repo_id: Optional[str] = None
        self._model_path: Optional[str] = None
        self._process: Optional[subprocess.Popen] = None
        self.port = os.environ.get("LLAMA_LLM_PORT", self.DEFAULT_PORT)
        self.api_url = f"http://127.0.0.1:{self.port}"

    def _convert_messages_to_prompt(self, messages: List[Dict[str, str]]) -> str:
        """Convert chat messages to a single prompt string.
        
        Args:
            messages: List of message dictionaries with 'content' key
            
        Returns:
            Formatted prompt string
        """
        lines = []
        for msg in messages:
            content = msg.get("content", "").strip()
            if content:
                lines.append(content)
        return "\n".join(lines) + "\n"

    def load_model(
        self, 
        params: LLMParams, 
        n_gpu_layers: int = -1, 
        context_length: int = None, 
        callback: Optional[Callable[[str], None]] = None
    ) -> None:
        """Load a model for inference.
        
        Args:
            params: Model parameters containing repo_id
            n_gpu_layers: Number of GPU layers (-1 for auto)
            context_length: Context window size
            callback: Optional callback for loading progress
            
        Raises:
            FileNotFoundError: If model file doesn't exist
            RuntimeError: If server fails to start
        """
        model_repo_id = params.model_repo_id
        if self._last_repo_id == model_repo_id:
            return 

        if callback:
            callback("start")

        self.unload_model()

        # Resolve model path
        self._model_path = self._resolve_model_path(model_repo_id)
        
        # Use provided parameters or defaults
        gpu_layers = n_gpu_layers if n_gpu_layers != -1 else self.DEFAULT_GPU_LAYERS
        
        # Start llama server
        self._start_server(gpu_layers)
        
        # Wait for server to be ready
        self._wait_for_server_ready()

        self._last_repo_id = model_repo_id

        if callback:
            callback("finish")

    def _resolve_model_path(self, model_repo_id: str) -> str:
        """Resolve model repository ID to local file path.
        
        Args:
            model_repo_id: Repository ID in format namespace/repo/model
            
        Returns:
            Absolute path to model file
            
        Raises:
            FileNotFoundError: If model file doesn't exist
        """
        model_base_path = config.llama_cpp_model_paths.get("ggufLLM")
        namespace, repo, *model = model_repo_id.split("/")
        model_path = path.abspath(
            path.join(model_base_path, "---".join([namespace, repo]), "---".join(model))
        )

        if not path.exists(model_path):
            raise FileNotFoundError(f"Model file not found: {model_path}")
            
        return model_path

    def _start_server(self, gpu_layers: int) -> None:
        """Start the llama-server subprocess.
        
        Args:
            gpu_layers: Number of GPU layers to use
        """
        exe_path = path.normpath(path.join("llama-cpp-rest", "llama-server.exe"))
        args = [
            exe_path,
            "--model", self._model_path,
            "--port", self.port,
            "-ngl", str(gpu_layers),
        ]

        self._process = subprocess.Popen(
            args, 
            stdout=subprocess.DEVNULL, 
            stderr=subprocess.DEVNULL
        )

    def _wait_for_server_ready(self) -> None:
        """Wait for the llama server to be ready for requests.
        
        Raises:
            RuntimeError: If server doesn't start within timeout
        """
        for attempt in range(self.SERVER_STARTUP_TIMEOUT):
            try:
                response = requests.get(
                    f"{self.api_url}/health", 
                    timeout=self.HEALTH_CHECK_TIMEOUT
                )
                print(f"[{attempt}] Server status: {response.status_code}")
                if response.status_code == 200:
                    print("LlamaCPP server is ready")
                    return
            except requests.RequestException as e:
                print(f"[{attempt}] Server not ready: {e}")
            time.sleep(1)
        
        raise RuntimeError(
            f"LlamaCPP server failed to start within {self.SERVER_STARTUP_TIMEOUT} seconds"
        )

    def create_chat_completion(
        self, 
        messages: List[Dict[str, str]], 
        max_tokens: int = None
    ) -> Iterator[str]:
        """Create a streaming chat completion.
        
        Args:
            messages: List of chat messages
            max_tokens: Maximum tokens to generate
            
        Yields:
            Generated text chunks
            
        Raises:
            requests.HTTPError: If API request fails
        """
        if max_tokens is None:
            max_tokens = self.DEFAULT_MAX_TOKENS
            
        prompt = self._convert_messages_to_prompt(messages)

        try:
            response = requests.post(
                f"{self.api_url}/completion",
                json={
                    "prompt": prompt, 
                    "n_predict": max_tokens, 
                    "stream": True, 
                    "stop": self.DEFAULT_STOP_SEQUENCES
                },
                stream=True
            )
            response.raise_for_status()

            for line in response.iter_lines(decode_unicode=True):
                if self.stop_generate:
                    self.stop_generate = False
                    break
                    
                if line:
                    try:
                        json_line = json.loads(line.strip().removeprefix("data: "))
                        content = json_line.get("content", "")
                        if content:
                            yield content
                    except (json.JSONDecodeError, KeyError):
                        # Skip malformed JSON lines
                        continue
                        
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to create chat completion: {e}")

    def unload_model(self) -> None:
        """Unload the current model and clean up resources."""
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print("Force killing llama-server process")
                self._process.kill()
                self._process.wait()
            finally:
                self._process = None
                
        self._model = None
        self._last_repo_id = None
        self._model_path = None
        gc.collect()

    def get_backend_type(self) -> str:
        """Get the backend type identifier.
        
        Returns:
            Backend type string
        """
        return "llama_cpp"

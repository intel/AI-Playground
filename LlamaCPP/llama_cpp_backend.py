import json
import os
from typing import Callable, Dict, Iterator, List, Optional
import requests
from interface import LLMInterface
from params import LLMParams


class LlamaCpp(LLMInterface):
    """LlamaCPP backend implementation for LLM inference using llama-server."""
    
    # Class constants
    DEFAULT_PORT = "39150"
    DEFAULT_CONTEXT_LENGTH = 2048
    DEFAULT_MAX_TOKENS = 1024
    HEALTH_CHECK_TIMEOUT = 1
    
    # Default stop sequences
    DEFAULT_STOP_SEQUENCES = ["\nUser:", "User:", "\n###", "</s>"]

    def __init__(self):
        """Initialize the LlamaCPP backend."""
        self._model = None  
        self.stop_generate = False
        self._last_repo_id: Optional[str] = None
        self.port = os.environ.get("LLAMA_LLM_PORT", self.DEFAULT_PORT)
        self.api_url = f"http://127.0.0.1:{self.port}"
        
        print(f"LlamaCPP client initialized for port {self.port}")

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

    def unload_model(self):
        pass

    def load_model(
        self, 
        params: LLMParams,
        callback: Optional[Callable[[str], None]] = None
    ) -> None:
        """Load a model for inference.
        
        Args:
            params: Model parameters containing repo_id
            callback: Optional callback for loading progress
        """
        model_repo_id = params.model_repo_id
        if self._last_repo_id == model_repo_id:
            return 

        if callback:
            callback("start")

        # Update internal state
        self._last_repo_id = model_repo_id
        self._model = model_repo_id  # Store for reference

        if callback:
            callback("finish")
            
        print(f"LlamaCPP client configured for model: {model_repo_id}")

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
            
        try:
            response = requests.post(
                f"{self.api_url}/v1/chat/completions",
                json={
                    "messages": messages, 
                    "max_completion_tokens": max_tokens, 
                    "stream": True, 
                    "stop": self.DEFAULT_STOP_SEQUENCES
                },
                stream=True
            )
            response.raise_for_status()

            for line in response.iter_lines():
                line = line.decode("utf-8")
                if self.stop_generate:
                    self.stop_generate = False
                    break
                    
                if line:
                    try:
                        json_line = json.loads(line.strip().removeprefix("data: "))
                        content = json_line["choices"][0]["delta"].get("content", "")
                        if content:
                            yield content
                    except (json.JSONDecodeError, KeyError):
                        # Skip malformed JSON lines
                        continue
                        
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to create chat completion: {e}")

    def get_backend_type(self) -> str:
        """Get the backend type identifier.
        
        Returns:
            Backend type string
        """
        return "llama_cpp"

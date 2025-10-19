from abc import ABC, abstractmethod
from typing import Dict, List, Optional
from params import LLMParams

class LLMInterface(ABC):
    """
    Abstract interface for LLM backends.
    
    This interface defines the common methods that all LLM backends must implement:
    - Default (IPEX)
    - LlamaCPP
    - OpenVINO
    """
    stop_generate: bool
    _model: Optional[object]

    @abstractmethod
    def load_model(self, params: LLMParams, **kwargs):
        """
        Load the model with the given parameters.
        
        Args:
            params: LLM parameters including model_repo_id, etc.
            **kwargs: Additional backend-specific parameters
        """
        pass

    @abstractmethod
    def unload_model(self):
        """
        Unload the model and free resources.
        """
        pass

    @abstractmethod
    def create_chat_completion(self, messages: List[Dict[str, str]]):
        """
        Generate a chat completion for the given messages.
        
        Args:
            messages: List of message dictionaries with "role" and "content" keys
        """
        pass 

    @abstractmethod
    def get_backend_type(self):
        """
        Get the type of the backend.
        
        Returns:
            String identifier for the backend type
        """
        pass

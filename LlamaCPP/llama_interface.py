from abc import ABC, abstractmethod
from typing import Dict, List, Optional
from llama_params import LLMParams

class LLMInterface(ABC):
    stop_generate: bool
    _model: Optional[object]

    @abstractmethod
    def load_model(self, params: LLMParams, **kwargs):
        pass

    @abstractmethod
    def unload_model(self):
        pass

    @abstractmethod
    def create_chat_completion(self, messages: List[Dict[str, str]]):
        pass 

    @abstractmethod
    def get_backend_type(self):
        pass
    

from typing import Any, Dict, List

class LLMParams:
    prompt: List[Dict[str, str]]
    device: int
    enable_rag: bool 
    model_repo_id: str
    max_tokens: int
    generation_parameters: Dict[str, Any]

    def __init__(
        self, prompt: list, device: int, enable_rag: bool, model_repo_id: str, max_tokens: int, **kwargs
    ) -> None:
        self.prompt = prompt
        self.device = device
        self.enable_rag = enable_rag
        self.model_repo_id = model_repo_id
        self.max_tokens = max_tokens
        self.generation_parameters = kwargs
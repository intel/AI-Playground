from typing import Any, Dict, List, Optional

class LLMParams:
    """
    Unified parameters class for all LLM backends.
    
    This class contains all parameters needed for LLM inference across different backends:
    - Default (IPEX)
    - LlamaCPP
    - OpenVINO
    """
    prompt: List[Dict[str, str]]
    device: int
    model_repo_id: str
    max_tokens: int
    external_rag_context: Optional[str]
    print_metrics: bool
    generation_parameters: Dict[str, Any]

    def __init__(
        self, prompt: list, device: int, model_repo_id: str, 
        max_tokens: int, external_rag_context: Optional[str] = None, 
        print_metrics: bool = True, 
        **kwargs
    ) -> None:
        """
        Initialize LLM parameters.
        
        Args:
            prompt: List of prompt dictionaries with "question" and optionally "answer" keys
            device: Device ID to run inference on
            model_repo_id: Model repository ID or path
            max_tokens: Maximum number of tokens to generate
            external_rag_context: Optional context from external RAG system
            print_metrics: Whether to print performance metrics
            **kwargs: Additional generation parameters passed to the model
        """
        self.prompt = prompt
        self.device = device
        self.model_repo_id = model_repo_id
        self.max_tokens = max_tokens
        self.external_rag_context = external_rag_context
        self.print_metrics = print_metrics
        self.generation_parameters = kwargs

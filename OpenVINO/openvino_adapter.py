from interface_adapter import InterfaceAdapter
from interface import LLMInterface

class LLM_SSE_Adapter(InterfaceAdapter):
    """
    Adapter for the OpenVINO backend.
    This class extends InterfaceAdapter to maintain backward compatibility.
    """
    
    def __init__(self, llm_interface: LLMInterface):
        """Initialize the adapter with an LLMInterface instance."""
        super().__init__(llm_interface)

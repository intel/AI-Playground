import traceback

import llm_biz
from params import LLMParams
from adapter import BaseAdapter

class ServiceAdapter(BaseAdapter):
    """Adapter for the default service backend."""
    
    def __init__(self, external_rag_context=None, external_rag_source=None):
        """Initialize the adapter with optional RAG parameters."""
        super().__init__()
        self.metrics_data = None
        self.external_rag_context = external_rag_context
        self.external_rag_source = external_rag_source
        
    def metrics_callback(self, msg: dict):
        """Callback for metrics data."""
        self.metrics_data = msg
        
    def text_conversation_run(self, params: LLMParams):
        """Run the text conversation using llm_biz.
        
        Args:
            params: LLM parameters
        """
        try:
            # Set RAG context and source on the params object if provided
            if self.external_rag_context is not None:
                params.external_rag_context = self.external_rag_context
            if self.external_rag_source is not None:
                params.external_rag_source = self.external_rag_source
                
            llm_biz.chat(
                params=params,
                load_model_callback=self.load_model_callback,
                text_out_callback=self.text_out_callback,
                error_callback=self.error_callback,
                metrics_callback=self.metrics_callback,
            )
            self.put_msg(self.metrics_data)
            self.put_msg({"type": "finish"})          

        except Exception as ex:
            traceback.print_exc()
            self.error_callback(ex)
        finally:
            self.finish = True
            self.signal.set()

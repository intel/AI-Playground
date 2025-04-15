import time
import traceback

from interface import LLMInterface
from params import LLMParams
from adapter import BaseAdapter, process_rag, convert_prompt

class InterfaceAdapter(BaseAdapter):
    """Adapter for backends implementing LLMInterface."""
    
    def __init__(self, llm_interface: LLMInterface):
        """Initialize the adapter with an LLMInterface instance."""
        super().__init__()
        self.llm_interface = llm_interface
        self.num_tokens = 0
        self.start_time = 0
        self.first_token_time = 0
        self.last_token_time = 0
        self.is_first_token = True
        
    def stream_function(self, output):
        """Process streaming output from the LLM.
        
        Args:
            output: The output from the LLM
            
        Returns:
            bool: True to stop generation, False to continue
        """
        if self.is_first_token:
            self.first_token_time = time.time()
            self.is_first_token = False
        
        self.text_out_callback(output)
        self.num_tokens += 1
        
        if self.llm_interface.stop_generate:
            self.put_msg("Stopping generation.")
            return True  # Stop generation
        
        return False
        
    def text_conversation_run(self, params: LLMParams):
        """Run the text conversation using the LLMInterface.
        
        Args:
            params: LLM parameters
        """
        try:
            self.llm_interface.load_model(params, callback=self.load_model_callback)
            
            # Reset metrics tracking
            self.num_tokens = 0
            self.start_time = time.time()
            self.first_token_time = 0
            self.last_token_time = 0
            self.is_first_token = True
            
            # Process RAG if external context is provided
            if params.external_rag_context:
                last_prompt = params.prompt[len(params.prompt) - 1]
                last_prompt["question"] = process_rag(
                    last_prompt["question"], 
                    params.external_rag_context,
                )
            
            full_prompt = convert_prompt(params.prompt)
            self.llm_interface.create_chat_completion(full_prompt, self.stream_function, params.max_tokens)
            
            # Calculate and send metrics
            self.last_token_time = time.time()
            metrics_data = {
                "type": "metrics",
                "num_tokens": self.num_tokens,
                "total_time": self.last_token_time - self.start_time,
                "overall_tokens_per_second": self.num_tokens / (self.last_token_time - self.start_time) if self.num_tokens > 0 else 0,
                "second_plus_tokens_per_second": (self.num_tokens - 1) / (self.last_token_time - self.first_token_time) if self.num_tokens > 1 else None,
                "first_token_latency": self.first_token_time - self.start_time if self.num_tokens > 0 else None,
                "after_token_latency": (self.last_token_time - self.first_token_time) / (self.num_tokens - 1) if self.num_tokens > 1 else None
            }
            self.put_msg(metrics_data)
            self.put_msg({"type": "finish"})
        
        except Exception as ex:
            traceback.print_exc()
            self.error_callback(ex)
        finally:
            self.llm_interface.stop_generate = False
            self.finish = True
            self.signal.set()

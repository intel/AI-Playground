import time
import traceback
from interface_adapter import InterfaceAdapter
from interface import LLMInterface
from adapter import process_rag

class LLM_SSE_Adapter(InterfaceAdapter):
    """
    Adapter for the LlamaCPP backend.
    This class extends InterfaceAdapter to maintain backward compatibility.
    """
    
    def __init__(self, llm_interface: LLMInterface):
        """Initialize the adapter with an LLMInterface instance."""
        super().__init__(llm_interface)
        
    def stream_function(self, stream):
        """
        Process streaming output from the LLM.
        This implementation handles both transformer-style and OpenAI-style outputs.
        
        Args:
            stream: The stream of outputs from the LLM
            
        Returns:
            None
        """
        self.num_tokens = 0
        self.start_time = time.time()
        self.is_first_token = True
        self.first_token_time = 0.0
        self.last_token_time = 0.0

        for output in stream:
            if self.llm_interface.stop_generate:
                self.llm_interface.stop_generate = False
                break
            
            if self.llm_interface.get_backend_type() == "ipex_llm":
                # transformer style
                self.text_out_callback(output)
            else:
                # openai style
                # Normalize output (works for raw strings or dicts)
                if isinstance(output, str):
                    content = output
                elif isinstance(output, dict):
                    content = output.get("content", "")
                else:
                    content = str(output)

                self.text_out_callback(content)

                self.num_tokens += 1

                if self.is_first_token:
                    self.first_token_time = time.time()
                    self.is_first_token = False

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
        
    def text_conversation_run(self, params):
        """
        Run the text conversation using the LLMInterface.
        This implementation overrides the base method to handle the LlamaCPP-specific stream format.
        
        Args:
            params: LLM parameters
        """
        try:
            self.llm_interface.load_model(params, callback=self.load_model_callback)
            
            # Process RAG if external context is provided
            if params.external_rag_context:
                last_prompt = params.prompt[len(params.prompt) - 1]
                last_prompt["question"] = process_rag(
                    last_prompt["question"], 
                    params.external_rag_context,
                )
            
            from adapter import convert_prompt
            full_prompt = convert_prompt(params.prompt)
            stream = self.llm_interface.create_chat_completion(full_prompt, params.max_tokens)
            self.stream_function(stream)
            
        except Exception as ex:
            traceback.print_exc()
            self.error_callback(ex)
        finally:
            self.finish = True
            self.signal.set()

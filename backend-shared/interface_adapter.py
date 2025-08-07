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
            result = self.llm_interface.create_chat_completion(full_prompt, self.stream_function, params.max_tokens)
            
            perf = result.perf_metrics
            ttft_ms, _   = perf.get_ttft()             
            tpot_ms, _   = perf.get_tpot()             
            gen_dur_ms, _= perf.get_generate_duration()
            thrpt_tps, _ = perf.get_throughput()       
            gen_tokens   = perf.get_num_generated_tokens() 

            metrics_data = {
                "type": "metrics",
                "num_tokens": gen_tokens,
                "total_time": gen_dur_ms,
                "overall_tokens_per_second": thrpt_tps,
                "second_plus_tokens_per_second": 1000.0 / tpot_ms if tpot_ms > 0 else 0.0,
                "first_token_latency": ttft_ms / 1000.0,
                "after_token_latency": tpot_ms / 1000.0,
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

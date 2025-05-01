import threading
from queue import Empty, Queue
import json
from typing import Dict, List, Callable

class BaseAdapter:
    """Base adapter class for all LLM backends."""
    
    def __init__(self):
        """Initialize the base adapter with common properties."""
        self.msg_queue = Queue(-1)
        self.finish = False
        self.signal = threading.Event()  # Fix typo: 'singal' -> 'signal'
        
    def put_msg(self, data):
        """Add a message to the queue and signal waiting threads."""
        self.msg_queue.put_nowait(data)
        self.signal.set()
        
    # Common callback methods
    def load_model_callback(self, event: str):
        """Callback for model loading events."""
        data = {"type": "load_model", "event": event}
        self.put_msg(data)
        
    def text_out_callback(self, msg: str, type=1):
        """Callback for text output."""
        data = {"type": "text_out", "value": msg, "dtype": type}
        self.put_msg(data)
    
    def first_latency_callback(self, first_latency: str):
        """Callback for first token latency."""
        data = {"type": "first_token_latency", "value": first_latency}
        self.put_msg(data)

    def after_latency_callback(self, after_latency: str):
        """Callback for after token latency."""
        data = {"type": "after_token_latency", "value": after_latency}
        self.put_msg(data)

    def sr_latency_callback(self, sr_latency: str):
        """Callback for SR latency."""
        data = {"type": "sr_latency", "value": sr_latency}
        self.put_msg(data)
    
    def error_callback(self, ex: Exception):
        """Handle errors in a standardized way."""
        # Common error handling logic with specific error types handled by subclasses
        if isinstance(ex, RuntimeError):
            self.put_msg({"type": "error", "err_type": "runtime_error"})
        else:
            self.put_msg({"type": "error", "err_type": "unknown_exception"})
        print(f"exception:{str(ex)}")
        
    def generator(self):
        """Generate SSE messages from the queue."""
        while True:
            while not self.msg_queue.empty():
                try:
                    data = self.msg_queue.get_nowait()
                    msg = f"data:{json.dumps(data)}\0"
                    yield msg
                except Empty:
                    break
            if not self.finish:
                self.signal.clear()
                self.signal.wait()
            else:
                break
                
    def text_conversation(self, params):
        """Start a text conversation with the LLM."""
        thread = threading.Thread(
            target=self.text_conversation_run,
            args=[params],
        )
        thread.start()
        return self.generator()
        
    def text_conversation_run(self, params):
        """Run the text conversation in a separate thread.
        
        This method must be implemented by subclasses.
        """
        raise NotImplementedError("Subclasses must implement this method")

# Common utility functions used by adapters

RAG_PROMPT_FORMAT = "Answer the questions based on the information below. \n{context}\n\nQuestion: {prompt}"

def process_rag(
        prompt: str,
        external_context: str,
    ):
    """
    Process RAG using only external documents.
    
    Args:
        prompt: The user's query
        external_context: Context from external RAG system (langchain.js)
        
    Returns:
        Formatted prompt with context
    """
    print("Using external RAG context\r\n{}".format(external_context))
    
            
    # Format the prompt with the external context
    return RAG_PROMPT_FORMAT.format(prompt=prompt, context=external_context)

_default_prompt = {
    "role": "system",
    "content": "You are a helpful digital assistant. Please provide safe, ethical and accurate information to the user. Please keep the output text language the same as the user input.",
}

def convert_prompt(prompt: List[Dict[str, str]]):
    """Convert a list of prompt dictionaries to a chat history format."""
    chat_history = [_default_prompt]
    prompt_len = len(prompt)
    i = 0
    while i < prompt_len:
        chat_history.append({"role": "user", "content": prompt[i].get("question")})
        if i < prompt_len - 1:
            chat_history.append(
                {"role": "assistant", "content": prompt[i].get("answer")}
            )
        i = i + 1
    return chat_history

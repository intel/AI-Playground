from typing import Dict, List, Callable
from os import path
from interface import LLMInterface
from params import LLMParams
from llama_cpp import CreateChatCompletionStreamResponse, Iterator, Llama
import config
import gc

class LlamaCpp(LLMInterface):
    def __init__(self):
        self._model = None
        self.stop_generate = False
        self._last_repo_id = None

    def load_model(self, params: LLMParams, n_gpu_layers: int = -1, context_length: int = 16000, callback: Callable[[str], None] = None):
        model_repo_id = params.model_repo_id
        if self._model is None or self._last_repo_id != model_repo_id:
            if callback is not None:
                callback("start")
            self.unload_model()

            model_base_path = config.llama_cpp_model_paths.get("ggufLLM")
            namespace, repo, *model = model_repo_id.split("/")
            model_path = path.abspath(path.join(model_base_path,"---".join([namespace, repo]), "---".join(model)))
            
            self._model = Llama(
                model_path=model_path,
                n_gpu_layers=n_gpu_layers,
                n_ctx=context_length,
                verbose=False,
            )

            self._last_repo_id = model_repo_id
            if callback is not None:
                callback("finish")

    def create_chat_completion(self, messages: List[Dict[str, str]], max_tokens: int = 1024):
        completion: Iterator[CreateChatCompletionStreamResponse] = self._model.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            stream=True,
        )
        return completion

    def unload_model(self):
        if self._model is not None:
            self._model.close()
            del self._model
        gc.collect()
        self._model = None

    def get_backend_type(self):
        return "llama_cpp"
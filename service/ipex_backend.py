from abc import ABC, abstractmethod
from typing import Dict, List
import gc
import threading
import time
import torch

from typing import List, Dict
from os import path
from typing import Callable
import service_config
from transformers import (
    TextIteratorStreamer,
    StoppingCriteriaList,
    AutoTokenizer,
    PreTrainedModel,
    PreTrainedTokenizer,
    TextStreamer
)
from llm_params import LLMParams
from ipex_llm.transformers import AutoModelForCausalLM


class IpexLLM(ABC):
    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._last_repo_id = None
        self.stop_generate = False
    
    def load_model(self, params: LLMParams):
        torch.xpu.set_device(params.device)
        model_config.device = f"xpu:{params.device}"
        model_repo_id = params.model_repo_id
        load_model_callback = None
        
        if self._model is None or self._last_repo_id != model_repo_id:
            # Free used resources
            self.unload_model()
               
            model_base_path = model_config.config.get("llm")
            model_name = model_repo_id.replace("/", "---")
            model_path = path.abspath(path.join(model_base_path, model_name))

            # load model
            if load_model_callback is not None:
                load_model_callback("start")
            start = time.time()

            load_in_low_bit="sym_int4"

            self._model = AutoModelForCausalLM.from_pretrained(
                model_path,
                torch_dtype=torch.float16,
                trust_remote_code=True,
                load_in_low_bit= load_in_low_bit,
                # load_in_4bit=True,
            )

            self._tokenizer = AutoTokenizer.from_pretrained(model_path)

            self._last_repo_id = model_repo_id

            print(
                "load llm model {} finish. cost {}s".format(
                    model_repo_id, round(time.time() - start, 3)
                )
            )
            if load_model_callback is not None:
                load_model_callback("finish")

    def unload_model(self):
        if self._model is not None:
            del self._model
        gc.collect()
        torch.xpu.empty_cache()
        self._model = None
        self._tokenizer = None

    def get_backend_type(self):
        return "ipex_llm"

    def create_chat_completion(self, messages: List[Dict[str, str]]):
        self._model = self._model.to(model_config.device)
        max_token = 1024
        new_prompt = self._tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        
        while len(self._tokenizer.tokenize(new_prompt)) > 2000:
            messages.remove(messages[1])
            new_prompt = messages.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )

        model_inputs = self._tokenizer(new_prompt, return_tensors="pt").to(model_config.device)

        streamer = TextIteratorStreamer(
            self._tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )

        generate_kwargs = dict(
            model_inputs,
            streamer=streamer,
            num_beams=1,
            do_sample=True,
            max_new_tokens=max_token,
        )

        chat_thread = threading.Thread(
            target=self._model.generate,
            kwargs=generate_kwargs,
        )

        chat_thread.start()

        return streamer
             

      
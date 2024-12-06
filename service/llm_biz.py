# Load model directly
import gc
import threading
import time
import traceback
import torch
import logging
import sys

from typing import List, Dict
from os import path
from transformers import (
    TextIteratorStreamer,
    StoppingCriteriaList,
    AutoTokenizer,
    PreTrainedModel,
    PreTrainedTokenizer,
    AutoModelForCausalLM
)

from ipex_llm.transformers import AutoModelForCausalLM
from typing import Callable
from transformers.generation.stopping_criteria import (
    StoppingCriteria,
    STOPPING_CRITERIA_INPUTS_DOCSTRING,
    add_start_docstrings,
)
import service_config


import ipex_llm.transformers.models.mistral

# W/A for https://github.com/intel/AI-Playground/issues/94
# Disable decoding_fast_path to avoid calling forward_qkv() which is not supported by bigdl-core-xe-*-23
ipex_llm.transformers.models.mistral.use_decoding_fast_path = (
    lambda *args, **kwargs: False
)


class LLMParams:
    prompt: List[Dict[str, str]]
    device: int
    enable_rag: bool
    model_repo_id: str
    print_metrics: bool

    def __init__(
            self,
            prompt: list,
            device: int,
            enable_rag: bool,
            model_repo_id: str,
            print_metrics: bool = True,
    ) -> None:
        self.prompt = prompt
        self.device = device
        self.enable_rag = enable_rag
        self.model_repo_id = model_repo_id
        self.print_metrics = print_metrics


RAG_PROMPT_FORMAT = "Answer the questions based on the information below. \n{context}\n\nQuestion: {prompt}"

_model: PreTrainedModel = None
_generating = False
_stop_generate = False
_stop_event = threading.Event()
_last_repo_id: str = None
_default_prompt = {
    "role": "system",
    "content": "You are a helpful digital assistant. Please provide safe, ethical and accurate information to the user. Please keep the output text language the same as the user input.",
}


def user_stop(input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs):
    global _stop_generate
    return _stop_generate


def stream_chat_generate(
        model: PreTrainedModel,
        args: dict,
        error_callback: Callable[[Exception], None] = None,
):
    try:
        model.generate(**args)
        sys.stdout.flush()
    except Exception as ex:
        traceback.print_exc()
        if error_callback is not None:
            error_callback(ex)


def generate(
        prompt: List[Dict[str, str]],
        model: PreTrainedModel,
        tokenizer: PreTrainedTokenizer,
        max_new_tokens: int,
        error_callback: Callable[[Exception], None] = None,
):
    logging.debug(f"got prompt: {prompt}")
    global _stop_generate, _default_prompt
    _stop_generate = False

    chat_history = [_default_prompt]
    prompt_len = prompt.__len__()
    i = 0
    while i < prompt_len:
        chat_history.append({"role": "user", "content": prompt[i].get("question")})
        if i < prompt_len - 1:
            chat_history.append(
                {"role": "assistant", "content": prompt[i].get("answer")}
            )
        i = i + 1

    new_prompt = tokenizer.apply_chat_template(
        chat_history, tokenize=False, add_generation_prompt=True
    )

    while len(tokenizer.tokenize(new_prompt)) > 2000:
        chat_history.remove(chat_history[1])
        new_prompt = tokenizer.apply_chat_template(
            chat_history, tokenize=False, add_generation_prompt=True
        )

    model_inputs = tokenizer(new_prompt, return_tensors="pt").to(service_config.device)
    ##tensor: torch.Tensor = encoding.get("input_ids")

    stopping_criteria = StoppingCriteriaList()

    stopping_criteria.append(CustomStopCriteria(user_stop))

    streamer = TextIteratorStreamer(
        tokenizer,
        skip_prompt=True,
        skip_special_tokens=True,
    )

    generate_kwargs = dict(
        model_inputs,
        streamer=streamer,
        num_beams=1,
        do_sample=True,
        max_new_tokens=max_new_tokens,
        stopping_criteria=stopping_criteria,
    )

    chat_thread = threading.Thread(
        target=stream_chat_generate,
        kwargs=dict(model=model, args=generate_kwargs, error_callback=error_callback),
    )

    chat_thread.start()

    return streamer


def process_rag(
        prompt: str,
        text_out_callback: Callable[[str, int], None] = None,
):
    import rag

    rag.to(service_config.device)
    query_success, context, rag_source = rag.query(prompt)
    if query_success:
        print("rag query input\r\n{}output:\r\n{}".format(prompt, context))
        prompt = RAG_PROMPT_FORMAT.format(prompt=prompt, context=context)
        if text_out_callback is not None:
            text_out_callback(rag_source, 2)
    return prompt


def chat(
        params: LLMParams,
        load_model_callback: Callable[[str], None] = None,
        text_out_callback: Callable[[str, int], None] = None,
        error_callback: Callable[[Exception], None] = None,
):
    global _model, _last_repo_id, _generating, _tokenizer, _stop_generate

    try:
        # if prev genera not finish, stop it
        stop_generate()

        torch.xpu.set_device(params.device)
        service_config.device = f"xpu:{params.device}"
        prompt = params.prompt
        enable_rag = params.enable_rag
        model_repo_id = params.model_repo_id
        max_token = 1024

        _generating = True

        _stop_generate = False

        if _model is None or _last_repo_id != model_repo_id:
            # if change model, free used resources
            if _model is not None:
                del _model
                gc.collect()
                torch.xpu.empty_cache()

            model_base_path = service_config.service_model_paths.get("llm")
            model_name = model_repo_id.replace("/", "---")
            model_path = path.abspath(path.join(model_base_path, model_name))

            # load model
            if load_model_callback is not None:
                load_model_callback("start")
            start = time.time()

            load_in_low_bit = "sym_int4"

            _model = AutoModelForCausalLM.from_pretrained(
                model_path,
                torch_dtype=torch.float16,
                trust_remote_code=True,
                load_in_low_bit=load_in_low_bit,
                # load_in_4bit=True,
            )

            _tokenizer = AutoTokenizer.from_pretrained(model_path)

            _last_repo_id = model_repo_id

            print(
                "load llm model {} finish. cost {}s".format(
                    model_repo_id, round(time.time() - start, 3)
                )
            )
            if load_model_callback is not None:
                load_model_callback("finish")

        assert_stop_generate()

        if enable_rag:
            last_prompt = prompt[prompt.__len__() - 1]
            last_prompt.__setitem__(
                "question", process_rag(last_prompt.get("question"), text_out_callback)
            )

        _model = _model.to(service_config.device)

        num_tokens = 0
        start_time = time.time()
        is_first = True
        first_token_time = 0
        last_token_time = 0
        with torch.inference_mode():
            all_stream_output = ""
            for stream_output in generate(
                    prompt, _model, _tokenizer, max_token, error_callback
            ):
                assert_stop_generate()

                num_tokens += 1
                if is_first:
                    first_token_time = time.time()
                    is_first = False

                if stream_output != "":
                    all_stream_output += stream_output
                    print(stream_output, end="")
                    text_out_callback(stream_output, 1)

        last_token_time = time.time()
        torch.xpu.empty_cache()
        if params.print_metrics:
            logging.info(f"""
                ----------inference finish----------
                num_tokens : {num_tokens}
                total_time : {last_token_time - start_time:.4f} s
                overall tokens/s : {num_tokens / (last_token_time - start_time):.4f}
                2nd+ token/s : {(num_tokens - 1) / (last_token_time - first_token_time):.4f}
                first_token_latency : {first_token_time - start_time:.4f} s
                after_token_latency : {(last_token_time - first_token_time)/(num_tokens - 1):.4f} s""")
    finally:
        _generating = False


def stop_generate():
    global _stop_generate, _generating, _stop_event
    if _generating:
        _stop_generate = True
        _stop_event.clear()
        _stop_event.wait()
        _generating = False
        _stop_generate = False


def assert_stop_generate():
    global _stop_generate, _stop_event
    if _stop_generate:
        _stop_event.set()
        raise StopGenerateException()


def dispose():
    global _stop_generate, _model
    stop_generate()

    del _model
    _model = None
    gc.collect()
    torch.xpu.empty_cache()


class StopGenerateException(Exception):
    def __str__(self):
        return "user stop llm generate"


class CustomStopCriteria(StoppingCriteria):
    def __init__(self, stop_callback):
        self.stop_callback = stop_callback

    @add_start_docstrings(STOPPING_CRITERIA_INPUTS_DOCSTRING)
    def __call__(
            self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs
    ) -> bool:
        return self.stop_callback(input_ids, scores, **kwargs)

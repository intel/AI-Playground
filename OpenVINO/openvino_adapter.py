import threading
from queue import Empty, Queue
import json
import traceback
from typing import Dict, List, Callable
from openvino_interface import LLMInterface
from openvino_params import LLMParams

RAG_PROMPT_FORMAT = "Answer the questions based on the information below. \n{context}\n\nQuestion: {prompt}"

class LLM_SSE_Adapter:
    msg_queue: Queue
    finish: bool
    singal: threading.Event
    llm_interface: LLMInterface
    should_stop: bool

    def __init__(self, llm_interface: LLMInterface):
        self.msg_queue = Queue(-1)
        self.finish = False
        self.singal = threading.Event()
        self.llm_interface = llm_interface
        self.should_stop = False

    def put_msg(self, data):
        self.msg_queue.put_nowait(data)
        self.singal.set()

    def load_model_callback(self, event: str):
        data = {"type": "load_model", "event": event}
        self.put_msg(data)

    def text_in_callback(self, msg: str):
        data = {"type": "text_in", "value": msg}
        self.put_msg(data)

    def text_out_callback(self, msg: str, type=1):
        data = {"type": "text_out", "value": msg, "dtype": type}
        self.put_msg(data)

    def first_latency_callback(self, first_latency: str):
        data = {"type": "first_token_latency", "value": first_latency}
        self.put_msg(data)

    def after_latency_callback(self, after_latency: str):
        data = {"type": "after_token_latency", "value": after_latency}
        self.put_msg(data)

    def sr_latency_callback(self, sr_latency: str):
        data = {"type": "sr_latency", "value": sr_latency}
        self.put_msg(data)

    def error_callback(self, ex: Exception):
        if (
            isinstance(ex, NotImplementedError)
            and ex.__str__() == "Access to repositories lists is not implemented."
        ):
            self.put_msg(
                {
                    "type": "error",
                    "err_type": "repositories_not_found",
                }
            )
        # elif isinstance(ex, NotEnoughDiskSpaceException):
        #     self.put_msg(
        #         {
        #             "type": "error",
        #             "err_type": "not_enough_disk_space",
        #             "need": bytes2human(ex.requires_space),
        #             "free": bytes2human(ex.free_space),
        #         }
        #     )
        # elif isinstance(ex, DownloadException):
        #     self.put_msg({"type": "error", "err_type": "download_exception"})
        # # elif isinstance(ex, llm_biz.StopGenerateException):
        # #     pass
        elif isinstance(ex, RuntimeError):
            self.put_msg({"type": "error", "err_type": "runtime_error"})
        else:
            self.put_msg({"type": "error", "err_type": "unknown_exception"})
        self.put_msg(f"exception:{str(ex)}")

    def text_conversation(self, params: LLMParams):
        thread = threading.Thread(
            target=self.text_conversation_run,
            args=[params],
        )
        thread.start()
        return self.generator()
    

    def stream_function(self, output):
        self.text_out_callback(output)
        if self.llm_interface.stop_generate:
            self.put_msg("Stopping generation.")
            return True  # Stop generation
        
        return False  
    

    def text_conversation_run(
        self,
        params: LLMParams,
    ):
        try:
            self.llm_interface.load_model(params, callback=self.load_model_callback)
            
            prompt = params.prompt
            full_prompt = convert_prompt(prompt)
            self.llm_interface.create_chat_completion(full_prompt, self.stream_function, params.max_tokens)
        
        except Exception as ex:
            traceback.print_exc()
            self.error_callback(ex)
        finally:
            self.llm_interface.stop_generate = False
            self.finish = True
            self.singal.set()

    def generator(self):
        while True:
            while not self.msg_queue.empty():
                try:
                    data = self.msg_queue.get_nowait()
                    msg = f"data:{json.dumps(data)}\0"
                    print(msg)
                    yield msg
                except Empty(Exception):
                    break
            if not self.finish:
                self.singal.clear()
                self.singal.wait()
            else:
                break


_default_prompt = {
        "role": "system",
        "content": "You are a helpful digital assistant. Please provide safe, ethical and accurate information to the user. Please keep the output text language the same as the user input.",
    }

def convert_prompt(prompt: List[Dict[str, str]]):
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
    return chat_history


def process_rag(
        prompt: str,
        device: str,
        text_out_callback: Callable[[str, int], None] = None,
    ):
        import rag
        rag.to(device)
        query_success, context, rag_source = rag.query(prompt)
        if query_success:
            print("rag query input\r\n{}output:\r\n{}".format(prompt, context))
            prompt = RAG_PROMPT_FORMAT.format(prompt=prompt, context=context)
            if text_out_callback is not None:
                text_out_callback(rag_source, 2)
        return prompt
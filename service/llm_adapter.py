import threading
from queue import Empty, Queue
import json
import traceback
import llm_biz
from model_downloader import NotEnoughDiskSpaceException, DownloadException
from psutil._common import bytes2human


class LLM_SSE_Adapter:
    msg_queue: Queue
    finish: bool
    singal: threading.Event

    def __init__(self):
        self.msg_queue = Queue(-1)
        self.finish = False
        self.singal = threading.Event()
        self.metrics_data = None

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
        elif isinstance(ex, NotEnoughDiskSpaceException):
            self.put_msg(
                {
                    "type": "error",
                    "err_type": "not_enough_disk_space",
                    "need": bytes2human(ex.requires_space),
                    "free": bytes2human(ex.free_space),
                }
            )
        elif isinstance(ex, DownloadException):
            self.put_msg({"type": "error", "err_type": "download_exception"})
        elif isinstance(ex, llm_biz.StopGenerateException):
            pass
        elif isinstance(ex, RuntimeError):
            self.put_msg({"type": "error", "err_type": "runtime_error"})
        else:
            self.put_msg({"type": "error", "err_type": "unknow_exception"})
        print(f"exception:{str(ex)}")

    
    def metrics_callback(self, msg: dict):
        self.metrics_data = msg

    def text_conversation(self, params: llm_biz.LLMParams):
        thread = threading.Thread(
            target=self.text_conversation_run,
            args=[params],
        )
        thread.start()
        return self.generator()

    def text_conversation_run(
        self,
        params: llm_biz.LLMParams,
    ):
        try:
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
            self.singal.set()

    def generator(self):
        while True:
            while not self.msg_queue.empty():
                try:
                    data = self.msg_queue.get_nowait()
                    msg = f"data:{json.dumps(data)}\0"
                    yield msg
                except Empty(Exception):
                    break
            if not self.finish:
                self.singal.clear()
                self.singal.wait()
            else:
                break

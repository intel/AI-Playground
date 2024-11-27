import os
import threading
from queue import Empty, Queue
import json
from file_downloader import FileDownloader
from model_downloader import NotEnoughDiskSpaceException, DownloadException
from psutil._common import bytes2human
from model_downloader import HFPlaygroundDownloader
import realesrgan
import aipg_utils as utils


class Model_Downloader_Adapter:
    msg_queue: Queue
    finish: bool
    singal: threading.Event
    file_downloader: FileDownloader
    hf_downloader: HFPlaygroundDownloader
    has_error: bool
    user_stop: bool

    def __init__(self, hf_token=None):
        self.msg_queue = Queue(-1)
        self.finish = False
        self.user_stop = False
        self.singal = threading.Event()
        self.file_downloader = FileDownloader()
        self.file_downloader.on_download_progress = (
            self.download_model_progress_callback
        )
        self.file_downloader.on_download_completed = (
            self.download_model_completed_callback
        )
        self.hf_downloader = HFPlaygroundDownloader(hf_token)
        self.hf_downloader.on_download_progress = self.download_model_progress_callback
        self.hf_downloader.on_download_completed = (
            self.download_model_completed_callback
        )

    def put_msg(self, data):
        self.msg_queue.put_nowait(data)
        self.singal.set()

    def download_model_progress_callback(
        self, repo_id: str, download_size: int, total_size: int, speed: int
    ):
        print(
            "download {} {}/{} speed {}".format(
                repo_id,
                bytes2human(download_size),
                bytes2human(total_size),
                bytes2human(speed),
            )
        )
        data = {
            "type": "download_model_progress",
            "repo_id": repo_id,
            "download_size": bytes2human(download_size),
            "total_size": bytes2human(total_size),
            "percent": round(download_size / total_size * 100, 2),
            "speed": "{}/s".format(bytes2human(speed)),
        }
        self.put_msg(data)

    def download_model_completed_callback(self, repo_id: str, ex: Exception):
        global _adapter
        if ex is not None:
            self.put_msg({"type": "error", "err_type": "download_exception"})
            self.has_error = True
            self.finish = True
        else:
            self.put_msg({"type": "download_model_completed", "repo_id": repo_id})
        _adapter = None

    def error_callback(self, ex: Exception):
        self.has_error = True
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
        elif isinstance(ex, RuntimeError):
            self.put_msg({"type": "error", "err_type": "runtime_error"})
        else:
            self.put_msg({"type": "error", "err_type": "unknow_exception"})
        print(f"exception:{str(ex)}")

    def download(self, list: list):
        self.has_error = False
        threading.Thread(target=self.__start_download, kwargs={"list": list}).start()
        return self.generator()

    def __start_download(self, list: list):
        self.finish = False
        self.user_stop = False
        try:
            for item in list:
                if self.user_stop:
                    break
                if self.has_error:
                    break
                if item["type"] == 4:
                    self.file_downloader.download_file(
                        realesrgan.ESRGAN_MODEL_URL,
                        os.path.join(
                            utils.get_model_path(item["type"]),
                            os.path.basename(realesrgan.ESRGAN_MODEL_URL),
                        ),
                    )
                else:
                    self.hf_downloader.download(item["repo_id"], item["type"], item["backend"])
            self.put_msg({"type": "allComplete"})
            self.finish = True
        except Exception as ex:
            self.error_callback(ex)

    def stop_download(self):
        self.user_stop = True
        if not self.file_downloader.completed:
            self.file_downloader.stop_download()
        if not self.hf_downloader.completed:
            self.hf_downloader.stop_download()

    def generator(self):
        while True:
            while not self.msg_queue.empty():
                try:
                    data = self.msg_queue.get_nowait()
                    msg = f"data:{json.dumps(data)}\0"
                    yield msg
                except Empty:
                    break
            if not self.finish:
                self.singal.clear()
                self.singal.wait()
            else:
                break


_adapter: Model_Downloader_Adapter = None

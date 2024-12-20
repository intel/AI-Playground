from datetime import datetime
import json
import threading
from queue import Empty, Queue
import traceback
from typing import Any
import paint_biz
from model_downloader import NotEnoughDiskSpaceException, DownloadException
from psutil._common import bytes2human
from PIL import Image
import os
import aipg_utils as utils


class SD_SSE_Adapter:
    msg_queue: Queue
    finish: bool
    singal: threading.Event
    url_root: str

    def __init__(self, url_root: str):
        self.msg_queue = Queue(-1)
        self.finish = False
        self.singal = threading.Event()
        self.url_root = url_root

    def put_msg(self, data):
        self.msg_queue.put_nowait(data)
        self.singal.set()

    def download_model_progress_callback(
        self, repo_id: str, download_size: int, total_size: int, speed: int
    ):
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
        if ex is not None:
            self.put_msg({"type": "error", "value": "DownloadModelFailed"})
        else:
            self.put_msg({"type": "download_model_completed", "repo_id": repo_id})

    def load_model_callback(self, event: str):
        data = {"type": "load_model", "event": event}
        self.put_msg(data)

    def load_model_components_callback(self, event: str):
        data = {"type": "load_model_components", "event": event}
        self.put_msg(data)

    def step_end_callback(
        self,
        index: int,
        step: int,
        total_step: int,
        preview_enabled: bool,
        image: Image.Image | None,
    ):
        if preview_enabled and image is not None:
            image = utils.image_to_base64(image)
        elif not preview_enabled:
            image = f"{self.url_root}/static/assets/aipg.png"

        data = {
            "type": "step_end",
            "index": index,
            "step": step,
            "total_step": total_step,
            "image": image,
        }
        self.put_msg(data)

    def image_out_callback(
        self,
        index: int,
        image: Image.Image | None,
        params: paint_biz.TextImageParams = None,
        safe_check_pass: bool = True,
    ):
        now = datetime.now()
        folder = now.strftime("%d_%m_%Y")
        base_name = now.strftime("%H%M%S")
        filename = "static/sd_out/{}/{}.png".format(folder, base_name)
        dir = os.path.dirname(filename)
        if not os.path.exists(dir):
            os.makedirs(dir)
        image.save(filename)
        utils.cache_file(filename, os.path.getsize(filename))

        response_params = self.get_response_params(
            image, os.path.getsize(filename), params
        )
        try:
            self.log_to_file(params, folder, base_name)
        except Exception:
            traceback.print_exc()
            pass
        image_url = f"{self.url_root}/{filename}"
        data = {
            "type": "image_out",
            "index": index,
            "image": image_url,
            "params": response_params,
            "safe_check_pass": safe_check_pass,
        }
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
        elif isinstance(ex, paint_biz.StopGenerateException):
            pass
        elif isinstance(ex, RuntimeError):
            self.put_msg({"type": "error", "err_type": "runtime_error"})
        else:
            self.put_msg({"type": "error", "err_type": "unknow_exception"})
        print(f"exception:{str(ex)}")

    def generate(self, params: paint_biz.TextImageParams):
        thread = threading.Thread(
            target=self.generate_run,
            args=[params],
        )
        thread.start()
        return self.generator()

    def generate_run(
        self,
        params: paint_biz.TextImageParams
        | paint_biz.ImageToImageParams
        | paint_biz.UpscaleImageParams
        | paint_biz.InpaintParams
        | paint_biz.OutpaintParams,
    ):
        try:
            paint_biz.load_model_callback = self.load_model_callback
            paint_biz.load_model_components_callback = (
                self.load_model_components_callback
            )
            paint_biz.step_end_callback = self.step_end_callback
            paint_biz.image_out_callback = self.image_out_callback
            paint_biz.download_progress_callback = self.download_model_progress_callback
            paint_biz.download_completed_callback = (
                self.download_model_completed_callback
            )
            paint_biz.generate(params=params)
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

    def get_response_params(
        self, image: Image.Image, size: int, params: paint_biz.TextImageParams
    ):
        response_params = {
            "width": image.width,
            "height": image.height,
            "size": bytes2human(size),
        }

        for key, value in params.__dict__.items():
            if key in [
                "generate_number",
                "image_preview",
                "width",
                "height",
            ] or isinstance(value, Image.Image):
                continue
            response_params.__setitem__(key, value)

        return response_params

    def log_to_file(self, params: Any, folder: str, base_name: str):
        from shutil import copyfile

        json_path = f"./static/sd_out/{folder}/history.json"
        base_output = os.path.abspath("./static/")
        if os.path.exists(json_path):
            try:
                with open(json_path, "r+") as f:
                    f.seek(12)
                    history_json = json.load(f)
            except Exception:
                os.remove(json_path)
                history_json = []
        else:
            history_json = []

        param_list = []
        for k, v in params.__dict__.items():
            if k == "generate_number" or k == "image_preview":
                continue
            elif k == "image" or k == "mask_image":
                save_path = os.path.abspath(str(v))
                save_path = save_path.replace(base_output, "../../").replace("\\", "/")
                param_list.append(
                    {
                        "name": k,
                        "type": "image",
                        "value": save_path,
                    }
                )
            else:
                param_list.append(
                    {
                        "name": k,
                        "value": v,
                        "type": "normal",
                    }
                )

        history_item = {
            "out_image": f"./{base_name}.png",
            "params": param_list,
        }

        history_json.insert(0, history_item)

        with open(json_path, "w") as f:
            f.write("let hisotry=")
            json.dump(history_json, f)
        html_path = f"./static/sd_out/{folder}/history.html"
        if not os.path.exists(html_path):
            copyfile("./static/assets/hisotory_template.html", html_path)

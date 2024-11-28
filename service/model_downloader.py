import concurrent.futures
import os
import queue
import shutil
import time
import traceback
from os import path, makedirs, rename
from threading import Thread, Lock
from time import sleep
from typing import Any, Callable, Dict, List

import psutil
import requests
from huggingface_hub import HfFileSystem, hf_hub_url, model_info
from psutil._common import bytes2human

import aipg_utils as utils
from exceptions import DownloadException

model_list_cache = dict()
model_lock = Lock()

class HFFileItem:
    relpath: str
    size: int
    url: str

    def __init__(self, relpath: str, size: int, url: str) -> None:
        self.relpath = relpath
        self.size = size
        self.url = url


class HFDonloadItem:
    name: str
    size: int
    url: str
    disk_file_size: int
    save_filename: str

    def __init__(
        self, name: str, size: int, url: str, disk_file_size: int, save_filename: str
    ) -> None:
        self.name = name
        self.size = size
        self.url = url
        self.disk_file_size = disk_file_size
        self.save_filename = save_filename


class NotEnoughDiskSpaceException(Exception):
    requires_space: int
    free_space: int

    def __init__(self, requires_space: int, free_space: int):
        self.requires_space = requires_space
        self.free_space = free_space
        message = "Not enough disk space. It requires {}, but only {} of free space is available".format(
            bytes2human(requires_space), bytes2human(free_space)
        )
        super().__init__(message)



class HFPlaygroundDownloader:
    fs: HfFileSystem
    file_queue: queue.Queue[HFDonloadItem]
    total_size: int
    download_size: int
    prev_sec_download_size: int
    on_download_progress: Callable[[str, int, int, int], None] = None
    on_download_completed: Callable[[str, Exception], None] = None
    thread_alive: int
    thread_lock: Lock
    download_stop: bool
    completed: bool
    wait_for_complete: bool
    repo_id: str
    save_path: str
    save_path_tmp: str
    error: Exception
    hf_token: str | None

    def __init__(self, hf_token=None) -> None:
        self.fs = HfFileSystem()
        self.total_size = 0
        self.download_size = 0
        self.thread_lock = Lock()
        self.hf_token = hf_token

    def hf_url_exists(self, repo_id: str):
        return self.fs.exists(repo_id)

    def probe_type(self, repo_id : str):
        return model_info(utils.trim_repo(repo_id)).pipeline_tag

    def is_gated(self, repo_id: str):
        try:
            info = model_info(utils.trim_repo(repo_id))
            return info.gated
        except Exception as ex:
            print(f"Error while trying to determine whether {repo_id} is gated: {ex}")
            return False

    def download(self, repo_id: str, model_type: int, backend: str, thread_count: int = 4):
        print(f"at download {backend}")
        self.repo_id = repo_id
        self.total_size = 0
        self.download_size = 0
        self.file_queue = queue.Queue()
        self.download_stop = False
        self.completed = False
        self.error = None
        self.save_path = path.join(utils.get_model_path(model_type, backend))
        self.save_path_tmp = path.abspath(
            path.join(self.save_path, repo_id.replace("/", "---") + "_tmp")
        )
        if not path.exists(self.save_path_tmp):
            makedirs(self.save_path_tmp)
        key = f"{repo_id}_{model_type}"
        cache_item = model_list_cache.get(key)
        if cache_item is None:
            file_list = list()
            self.enum_file_list(file_list, repo_id, model_type)
            model_list_cache.__setitem__(
                {"size": self.total_size, "queue": self.file_queue}
            )
        else:
            self.total_size = cache_item["size"]
            file_list: list = cache_item["queue"]

        self.build_queue(file_list)

        usage = psutil.disk_usage(self.save_path)
        if self.total_size - self.download_size > usage.free:
            raise NotEnoughDiskSpaceException(
                self.total_size - self.download_size, usage.free
            )
        self.multiple_thread_downlod(thread_count)

    def build_queue(self, file_list: list[HFFileItem]):
        for file in file_list:
            save_filename = path.abspath(path.join(self.save_path_tmp, file.relpath))
            if path.exists(save_filename):
                local_file_size = path.getsize(save_filename)
                self.download_size += local_file_size
                # if local file size less thand network file size download it, else skip it!
                if local_file_size < file.size:
                    self.file_queue.put(
                        HFDonloadItem(
                            file.relpath,
                            file.size,
                            file.url,
                            local_file_size,
                            save_filename,
                        )
                    )
            else:
                self.file_queue.put(
                    HFDonloadItem(file.relpath, file.size, file.url, 0, save_filename)
                )

    def get_model_total_size(self, repo_id: str, model_type: int):
        key = f"{repo_id}_{model_type}"
        self.repo_id = repo_id
        with model_lock:
            item = model_list_cache.get(key)

        if item is None:
            file_list = list()
            self.enum_file_list(file_list, repo_id, model_type)
            with model_lock:
                model_list_cache.__setitem__(
                    key, {"size": self.total_size, "queue": file_list}
                )
            return self.total_size
        else:
            return item["size"]

    def enum_file_list(
        self, file_list: List, enum_path: str, model_type: int, is_root=True
    ):
        # repo = "/".join(enum_path.split("/")[:2])
        list = self.fs.ls(enum_path, detail=True)
        if model_type == 1 and enum_path == self.repo_id + "/unet":
            list = self.enum_sd_unet(list)
        for item in list:
            name: str = item.get("name")
            size: int = item.get("size")
            type: str = item.get("type")
            if type == "directory":
                self.enum_file_list(file_list, name, model_type, False)
            else:
                # sd model ignore root .safetensors .pt .ckpt files
                if (
                    model_type == 1
                    and is_root
                    and (
                        name.endswith(".safetensors")
                        or name.endswith(".pt")
                        or name.endswith(".ckpt")
                    )
                ):
                    continue
                elif model_type == 5 and (
                    name.endswith(".safetensors") or name.endswith(".onnx")
                ):
                    continue
                # ignore no used files
                elif (
                    name.endswith(".png")
                    or name.endswith(".gitattributes")
                    or name.endswith(".md")
                    or name.endswith(".jpg")
                    or name.endswith(".pdf")
                    or name.endswith(".html")
                ):
                    continue

                self.total_size += size
                relative_path = path.relpath(name, utils.trim_repo(self.repo_id))
                subfolder = path.dirname(relative_path).replace("\\", "/")
                filename = path.basename(relative_path)
                url = hf_hub_url(
                    repo_id=utils.trim_repo(self.repo_id), subfolder=subfolder, filename=filename
                )
                file_list.append(HFFileItem(relative_path, size, url))


    def enum_sd_unet(self, file_list: List[str | Dict[str, Any]]):
        cur_level = 0
        first_model = None
        model_levels = [(".fp32.", 3), (".fp16.", 2), ("", 1)]
        new_list = list()
        for item in file_list:
            name = str(item.get("name"))
            if name.endswith(".safetensors") or name.endswith(".bin"):
                for lv_item in model_levels:
                    ext, lv = lv_item
                    if name.__contains__(ext):
                        if lv > cur_level:
                            cur_level = lv
                            first_model = item
            else:
                new_list.append(item)
        new_list.append(first_model)
        return new_list

    def multiple_thread_downlod(self, thread_count: int):
        self.download_stop = False
        if self.on_download_progress is not None:
            self.prev_sec_download_size = 0
            report_thread = self.start_report_download_progress()
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=thread_count
        ) as executor:
            futures = [
                executor.submit(self.download_model_file)
                for _ in range(min(thread_count, self.file_queue.qsize()))
            ]
            concurrent.futures.wait(futures)
            executor.shutdown()
        self.completed = True
        if report_thread is not None:
            report_thread.join()
        if self.on_download_completed is not None:
            self.on_download_completed(self.repo_id, self.error)
        if not self.download_stop and self.error is None:
            self.move_to_desired_position()
        else:
            # Download aborted
            shutil.rmtree(self.save_path_tmp)

    def move_to_desired_position(self, retriable: bool = True):
        desired_repo_root_dir_name = os.path.join(self.save_path, utils.repo_local_root_dir_name(self.repo_id))
        try:
            if os.path.exists(desired_repo_root_dir_name):
                for item in os.listdir(self.save_path_tmp):
                    shutil.move(os.path.join(self.save_path_tmp, item), desired_repo_root_dir_name)
                shutil.rmtree(self.save_path_tmp)
            else:
                rename(
                    self.save_path_tmp,
                    path.abspath(desired_repo_root_dir_name)
                )
        except Exception as e:
            if (retriable):
                sleep(5)
                self.move_to_desired_position(retriable=False)
            else:
                raise e


    def start_report_download_progress(self):
        thread = Thread(target=self.report_download_progress)
        thread.start()
        return thread

    def report_download_progress(self):
        while not self.download_stop and not self.completed:
            self.on_download_progress(
                self.repo_id,
                self.download_size,
                self.total_size,
                self.download_size - self.prev_sec_download_size,
            )

            self.prev_sec_download_size = self.download_size
            time.sleep(1)

    def init_download(self, file: HFDonloadItem):
        makedirs(path.dirname(file.save_filename), exist_ok=True)

        headers = {}
        if self.hf_token is not None:
            headers["Authorization"] = f"Bearer {self.hf_token}"

        if file.disk_file_size > 0:
            # download skip exists part
            headers["Range"] = f"bytes={file.disk_file_size}-"
            response = requests.get(
                file.url,
                stream=True,
                verify=False,
                headers=headers,
            )
            fw = open(file.save_filename, "ab")
        else:
            response = requests.get(
                file.url, stream=True, verify=False, headers=headers
            )
            fw = open(file.save_filename, "wb")

        return response, fw

    def download_model_file(self):
        try:
            while not self.download_stop and not self.file_queue.empty():
                file = self.file_queue.get_nowait()
                download_retry = 0
                while True:
                    try:
                        response, fw = self.init_download(file)
                        if response.status_code != 200:
                            download_retry += 2  # we only want to retry once in case of non network errors
                            raise DownloadException(file.url)
                        # start download file
                        with response:
                            with fw:
                                for bytes in response.iter_content(chunk_size=4096):
                                    download_len = bytes.__len__()
                                    with self.thread_lock:
                                        self.download_size += download_len
                                    file.disk_file_size += fw.write(bytes)
                                    if self.download_stop:
                                        print(
                                            f"thread {Thread.native_id} exit by user stop"
                                        )
                                        break
                        break
                    except Exception:
                        traceback.print_exc()
                        download_retry += 1
                        if download_retry < 4:
                            print(
                                f"download file {file.url} failed. retry {download_retry} time"
                            )
                            time.sleep(download_retry)
                        else:
                            raise DownloadException(file.url)

        except Exception as ex:
            self.error = ex
            traceback.print_exc()

    def stop_download(self):
        self.download_stop = True


def test_download_progress(dowanlod_size: int, total_size: int, speed: int):
    print(f"download {dowanlod_size/1024}/{total_size /1024}KB  speed {speed}/s")


def test_download_complete(ex: Exception):
    if ex is None:
        print("download success")
    else:
        print(f"{ex}")


def init():
    downloader = HFPlaygroundDownloader()
    downloader.on_download_progress = test_download_progress
    downloader.on_download_completed = test_download_complete
    total_size = downloader.download("RunDiffusion/Juggernaut-X-v10", 1, thread_count=1)
    print(f"total-size: {total_size}")


if __name__ == "__main__":
    init()

import base64
import hashlib
import io
import logging
import math
import os
import shutil
from typing import IO

import torch
from PIL import Image

import service_config
import subprocess
import shlex


def image_to_base64(image: Image.Image):
    buffered = io.BytesIO()
    image.save(buffered, format="PNG")
    return "data:image/png;base64,{}".format(
        base64.b64encode(buffered.getvalue()).decode("utf-8")
    )


def generate_mask_image(mask_flag_bytes: bytes, width: int, height: int):
    from PIL import Image
    import numpy as np

    np_data = np.frombuffer(mask_flag_bytes, dtype=np.uint8)
    image = Image.fromarray(np_data.reshape((height, width)), mode="L").convert("RGB")

    return image


def get_shape_ceil(h: float, w: float):
    return math.ceil(((h * w) ** 0.5) / 64.0) * 64.0


def get_image_shape_ceil(image: Image.Image):
    H, W = image.shape[:2]
    return get_shape_ceil(H, W)


def check_mmodel_exist(type: int, repo_id: str, backend: str) -> bool:
    match(backend):
        case "default":
            return check_defaultbackend_mmodel_exist(type, repo_id)
        case "comfyui":
            return check_comfyui_model_exists(type, repo_id)
        case _:
            raise NameError("Unknown Backend")

def check_comfyui_model_exists(type, repo_id) -> bool:
    model_dir = service_config.comfy_ui_model_paths.get(convert_model_type(type))
    dir_to_look_for = os.path.join(model_dir, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def trim_repo(repo_id):
    return "/".join(repo_id.split("/")[:2])

def extract_model_id_pathsegments(repo_id) -> str:
    return "/".join(repo_id.split("/")[2:])

def repo_local_root_dir_name(repo_id):
    return "---".join(repo_id.split("/")[:2])

def check_defaultbackend_mmodel_exist(type: int, repo_id: str) -> bool:
    import service_config

    folder_name = repo_local_root_dir_name(repo_id)
    if type == 0:
        dir = service_config.service_model_paths.get("llm")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 1:
        dir = service_config.service_model_paths.get("stableDiffusion")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(os.path.join(dir, folder_name, "model_index.json"))
    elif type == 2:
        dir = service_config.service_model_paths.get("lora")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.safetensors")
            ) or os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.bin")
            )
    elif type == 3:
        dir = service_config.service_model_paths.get("vae")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 4:
        import realesrgan

        dir = service_config.service_model_paths.get("ESRGAN")
        return os.path.exists(
            os.path.join(dir, realesrgan.ESRGAN_MODEL_URL.split("/")[-1])
        )
    elif type == 5:
        dir = service_config.service_model_paths.get("embedding")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 6:
        dir = service_config.service_model_paths.get("inpaint")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, repo_id.replace("/", "---"), "model_index.json")
            )
    elif type == 7:
        dir = service_config.service_model_paths.get("preview")
        return (
            os.path.exists(os.path.join(dir, folder_name, "config.json"))
            or os.path.exists(os.path.join(dir, f"{repo_id}.safetensors"))
            or os.path.exists(os.path.join(dir, f"{repo_id}.bin"))
        )


def convert_model_type(type: int):
    if type == 0:
        return "llm"
    elif type == 1:
        return "stableDiffusion"
    elif type == 2:
        return "lora"
    elif type == 3:
        return "vae"
    elif type == 4:
        return "ESRGAN"
    elif type == 5:
        return "embedding"
    elif type == 6:
        return "inpaint"
    elif type == 7:
        return "preview"

    elif type == 100:
        return "unet"
    elif type == 101:
        return "clip"
    elif type == 102:
        return "vae"
    elif type == 103:
        return "defaultCheckpoint"
    elif type == 104:
        return "defaultLora"
    elif type == 105:
        return "controlNet"
    elif type == 106:
        return "faceswap"
    else:
        raise Exception(f"unknown model type value {type}")


def get_model_path(type: int, backend: str):
    match backend:
        case "default":
            return service_config.service_model_paths.get(convert_model_type(type))
        case "comfyui":
            return service_config.comfy_ui_model_paths.get(convert_model_type(type))



def calculate_md5(file_path: str):
    with open(file_path, "rb") as f:
        file_hash = hashlib.md5()
        while chunk := f.read(8192):
            file_hash.update(chunk)
    return file_hash.hexdigest()


def create_cache_path(md5: str, file_size: int):
    cache_dir = "./cache"
    sub_dirs = [md5[i : i + 4] for i in range(0, len(md5), 4)]
    cache_path = os.path.abspath(
        os.path.join(cache_dir, *sub_dirs, f"{md5}_{file_size}")
    )
    return cache_path


def calculate_md5_from_stream(file_stream: IO[bytes]):
    file_hash = hashlib.md5()
    for chunk in iter(lambda: file_stream.read(8192), b""):
        file_hash.update(chunk)
    return file_hash.hexdigest()


def cache_file(file_path: IO[bytes] | str, file_size: int):
    md5 = calculate_md5(file_path)

    cache_path = create_cache_path(md5, file_size)

    if not os.path.exists(cache_path):
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        os.rename(file_path, cache_path)

    if os.path.exists(file_path):
        os.remove(file_path)
    os.link(cache_path, file_path)


def is_single_file(filename: str):
    return filename.endswith(".safetensors") or filename.endswith(".bin")


def get_ESRGAN_size():
    import requests
    import realesrgan

    response = requests.get(realesrgan.ESRGAN_MODEL_URL, stream=True)
    with response:
        return int(response.headers.get("Content-Length"))


def get_support_graphics(env_type: str):
    device_count = torch.xpu.device_count()
    service_config.env_type = env_type
    graphics = list()
    for i in range(device_count):
        device_name = torch.xpu.get_device_name(i)
        # if device_name == "Intel(R) Arc(TM) Graphics" or re.search("Intel\(R\) Arc\(TM\)", device_name) is not None:
        graphics.append({"index": i, "name": device_name})
    return graphics


def call_subprocess(process_command: str) -> str:
    args = shlex.split(process_command)
    try:
        logging.info(f"calling cmd process: {args}")
        output = subprocess.check_output(args)
        return output.decode("utf-8")
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to call subprocess {process_command} with error {e}")
        raise e

def remove_existing_filesystem_resource(path: str):
    if os.path.exists(path):
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

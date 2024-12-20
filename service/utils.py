import base64
import math
from typing import IO
from PIL import Image
import io
import os
import hashlib
import torch


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


def check_mmodel_exist(type: int, repo_id: str):
    import model_config

    folder_name = repo_id.replace("/", "---")
    if type == 0:
        dir = model_config.config.get("llm")
        return os.path.exists(os.path.join(dir, folder_name, "config.json"))
    elif type == 1:
        dir = model_config.config.get("stableDiffusion")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(os.path.join(dir, folder_name, "model_index.json"))
    elif type == 2:
        dir = model_config.config.get("lora")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.safetensors")
            ) or os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.bin")
            )
    elif type == 3:
        dir = model_config.config.get("vae")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 4:
        import realesrgan

        dir = model_config.config.get("ESRGAN")
        return os.path.exists(
            os.path.join(dir, realesrgan.ESRGAN_MODEL_URL.split("/")[-1])
        )
    elif type == 5:
        dir = model_config.config.get("embedding")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 6:
        dir = model_config.config.get("inpaint")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, repo_id.replace("/", "---"), "model_index.json")
            )
    elif type == 7:
        dir = model_config.config.get("preview")
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
    else:
        raise Exception(f"uwnkown model type value {type}")


def get_model_path(type: int):
    import model_config

    return model_config.config.get(convert_model_type(type))


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
    import model_config

    device_count = torch.xpu.device_count()
    model_config.env_type = env_type
    graphics = list()
    for i in range(device_count):
        device_name = torch.xpu.get_device_name(i)
        # if device_name == "Intel(R) Arc(TM) Graphics" or re.search("Intel\(R\) Arc\(TM\)", device_name) is not None:
        graphics.append({"index": i, "name": device_name})
    return graphics

import base64
import io
import os
import logging
import math
import subprocess
import shlex
from typing import Optional

import torch
from PIL import Image

# Import from the shared modules
import config
import utils

# Re-export all utility functions from the shared module
check_mmodel_exist = utils.check_mmodel_exist
check_openvino_model_exists = utils.check_openvino_model_exists
check_llama_cpp_model_exists = utils.check_llama_cpp_model_exists
check_comfyui_model_exists = utils.check_comfyui_model_exists
check_defaultbackend_mmodel_exist = utils.check_defaultbackend_mmodel_exist
trim_repo = utils.trim_repo
extract_model_id_pathsegments = utils.extract_model_id_pathsegments
repo_local_root_dir_name = utils.repo_local_root_dir_name
flat_repo_local_dir_name = utils.flat_repo_local_dir_name
get_model_path = utils.get_model_path
create_cache_path = utils.create_cache_path
cache_file = utils.cache_file
is_single_file = utils.is_single_file
remove_existing_filesystem_resource = utils.remove_existing_filesystem_resource

# Import the convert_model_type function from the config module
convert_model_type = config.convert_model_type

# Keep the image-related functions in this file since they're specific to the service
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

def get_ESRGAN_size():
    import requests
    import realesrgan

    response = requests.get(realesrgan.ESRGAN_MODEL_URL, stream=True)
    with response:
        return int(response.headers.get("Content-Length"))

def get_support_graphics():
    device_count = torch.xpu.device_count()
    graphics = list()
    for i in range(device_count):
        device_name = torch.xpu.get_device_name(i)
        graphics.append({"index": i, "name": device_name})
    return graphics

def call_subprocess(process_command: str, cwd: Optional[str] = None) -> str:
    args = shlex.split(process_command)
    try:
        logging.info(f"calling cmd process: {args}")
        output = subprocess.check_output(args, cwd=cwd, env={**os.environ, "PIP_CONFIG_FILE": os.devnull})
        return output.decode("utf-8").strip()
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to call subprocess {process_command} with error {e}")
        raise e

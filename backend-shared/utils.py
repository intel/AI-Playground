import hashlib
import logging
import os
import shutil
from typing import IO

# Import from the backend_shared package
import config

# Path handling utilities
def repo_local_root_dir_name(repo_id):
    """Convert a repo ID to a local directory name by replacing / with ---"""
    return "---".join(repo_id.split("/")[:2])

def extract_model_id_pathsegments(repo_id) -> str:
    """Extract the model ID path segments from a repo ID"""
    return "/".join(repo_id.split("/")[2:])

def flat_repo_local_dir_name(repo_id):
    """Convert a repo ID to a flat local directory name by replacing all / with ---"""
    return "---".join(repo_id.split("/"))

def trim_repo(repo_id):
    """Trim a repo ID to just the first two segments"""
    return "/".join(repo_id.split("/")[:2])

def is_single_file(filename: str):
    """Check if a filename is a single file (not a directory)"""
    return filename.endswith(".safetensors") or filename.endswith(".bin") or filename.endswith(".gguf")

# Model path and existence checking
def get_model_path(type: int, backend: str):
    """Get the model path for a given type and backend"""
    logging.info(f'getting model path for type {type} and backend {backend}')
    match backend:
        case "default":
            return config.service_model_paths.get(config.convert_model_type(type))
        case "llama_cpp":
            return config.llama_cpp_model_paths.get(config.convert_model_type(type))
        case "openvino":
            return config.openvino_model_paths.get(config.convert_model_type(type))
        case "comfyui":
            return config.comfy_ui_model_paths.get(config.convert_model_type(type))

def check_mmodel_exist(type: int, repo_id: str, backend: str) -> bool:
    """Check if a model exists for a given type and backend"""
    logging.info(f'checking model {repo_id} of type {type} in backend {backend}')
    match(backend):
        case "default":
            return check_defaultbackend_mmodel_exist(type, repo_id)
        case "openvino":
            return check_openvino_model_exists(type, repo_id)
        case "comfyui":
            return check_comfyui_model_exists(type, repo_id)
        case "llama_cpp":
            return check_llama_cpp_model_exists(type, repo_id)
        case _:
            raise NameError("Unknown Backend")

def check_openvino_model_exists(type, repo_id) -> bool:
    """Check if an OpenVINO model exists"""
    folder_name = repo_local_root_dir_name(repo_id)
    dir = config.openvino_model_paths.get(config.convert_model_type(type))
    return os.path.exists(os.path.join(dir, folder_name))

def check_llama_cpp_model_exists(type, repo_id) -> bool:
    """Check if a LlamaCPP model exists"""
    model_dir = config.llama_cpp_model_paths.get(config.convert_model_type(type))
    dir_to_look_for = os.path.join(model_dir, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def check_comfyui_model_exists(type, repo_id) -> bool:
    """Check if a ComfyUI model exists"""
    model_type = config.convert_model_type(type)
    model_dir = config.comfy_ui_model_paths.get(model_type)
    if model_type == 'faceswap' or model_type == 'facerestore':
        dir_to_look_for = os.path.join(model_dir, flat_repo_local_dir_name(repo_id))
    elif model_type == 'nsfwdetector':
        dir_to_look_for = os.path.join(model_dir, 'vit-base-nsfw-detector', extract_model_id_pathsegments(repo_id))
    else:
        dir_to_look_for = os.path.join(model_dir, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def check_defaultbackend_mmodel_exist(type: int, repo_id: str) -> bool:
    """Check if a default backend model exists"""
    logging.info(f'checking default backend model {repo_id} of type {type}')
    folder_name = repo_local_root_dir_name(repo_id)
    if type == 0:
        dir = config.service_model_paths.get("llm")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 1:
        dir = config.service_model_paths.get("stableDiffusion")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(os.path.join(dir, folder_name, "model_index.json"))
    elif type == 2:
        dir = config.service_model_paths.get("lora")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.safetensors")
            ) or os.path.exists(
                os.path.join(dir, folder_name, "pytorch_lora_weights.bin")
            )
    elif type == 3:
        dir = config.service_model_paths.get("vae")
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 4:
        import realesrgan

        dir = config.service_model_paths.get("ESRGAN")
        return os.path.exists(
            os.path.join(dir, realesrgan.ESRGAN_MODEL_URL.split("/")[-1])
        )
    elif type == 5:
        dir = config.service_model_paths.get("embedding")
        logging.info(f'Checking embedding model {repo_id} of type {type} in {dir}')
        return os.path.exists(os.path.join(dir, folder_name))
    elif type == 6:
        dir = config.service_model_paths.get("inpaint")
        if is_single_file(repo_id):
            return os.path.exists(os.path.join(dir, repo_id))
        else:
            return os.path.exists(
                os.path.join(dir, repo_id.replace("/", "---"), "model_index.json")
            )
    elif type == 7:
        dir = config.service_model_paths.get("preview")
        return (
                os.path.exists(os.path.join(dir, folder_name, "config.json"))
                or os.path.exists(os.path.join(dir, f"{repo_id}.safetensors"))
                or os.path.exists(os.path.join(dir, f"{repo_id}.bin"))
        )

# File operations
def calculate_md5(file_path: str):
    """Calculate the MD5 hash of a file"""
    with open(file_path, "rb") as f:
        file_hash = hashlib.md5()
        while chunk := f.read(8192):
            file_hash.update(chunk)
    return file_hash.hexdigest()

def calculate_md5_from_stream(file_stream: IO[bytes]):
    """Calculate the MD5 hash of a file stream"""
    file_hash = hashlib.md5()
    for chunk in iter(lambda: file_stream.read(8192), b""):
        file_hash.update(chunk)
    return file_hash.hexdigest()

def create_cache_path(md5: str, file_size: int):
    """Create a cache path for a file based on its MD5 hash and size"""
    cache_dir = "./cache"
    sub_dirs = [md5[i : i + 4] for i in range(0, len(md5), 4)]
    cache_path = os.path.abspath(
        os.path.join(cache_dir, *sub_dirs, f"{md5}_{file_size}")
    )
    return cache_path

def cache_file(file_path: IO[bytes] | str, file_size: int):
    """Cache a file using its MD5 hash and size"""
    md5 = calculate_md5(file_path)

    cache_path = create_cache_path(md5, file_size)

    if not os.path.exists(cache_path):
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        os.rename(file_path, cache_path)

    if os.path.exists(file_path):
        os.remove(file_path)
    os.link(cache_path, file_path)

def remove_existing_filesystem_resource(path: str):
    """Remove an existing file or directory"""
    if os.path.exists(path):
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

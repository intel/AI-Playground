import hashlib
import logging
import os
import shutil
from typing import IO, List

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
def get_model_path(type: str, backend: str):
    """Get the model path for a given type and backend"""
    logging.info(f'getting model path for type {type} and backend {backend}')
    match backend:
        case "default":
            # Default backend (old ipexllm) is no longer supported
            logging.warning(f'Default backend (ipexllm) is no longer supported. Cannot get model path for type {type}.')
            return None
        case "llama_cpp":
            return config.llama_cpp_model_paths.get(type)
        case "openvino":
            return config.openvino_model_paths.get(type)
        case "comfyui":
            return config.comfy_ui_model_paths.get(type)

def check_mmodel_exist(type: str, repo_id: str, backend: str, model_path: str = None) -> bool:
    """Check if a model exists for a given type and backend"""
    logging.info(f'checking model {repo_id} of type {type} in backend {backend}')
    if model_path:
        # Use provided model_path directly
        return check_model_exists_with_path(type, repo_id, model_path)
    # Fallback to old behavior for backward compatibility
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

def check_model_exists_with_path(type: str, repo_id: str, model_path: str) -> bool:
    """Check if a model exists at the given path"""
    # Resolve absolute path
    model_path = os.path.abspath(model_path)
    
    if type == 'faceswap' or type == 'facerestore':
        dir_to_look_for = os.path.join(model_path, flat_repo_local_dir_name(repo_id))
    elif type == 'nsfwdetector':
        dir_to_look_for = os.path.join(model_path, 'vit-base-nsfw-detector', extract_model_id_pathsegments(repo_id))
    elif type == 'ggufLLM' or (isinstance(repo_id, str) and repo_id.endswith('.gguf')):
        # For GGUF files, check if the file exists directly
        dir_to_look_for = os.path.join(model_path, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
        # Check if it's a direct file path
        if os.path.isfile(dir_to_look_for):
            return True
        # Check if any .gguf file exists in the directory
        parent_dir = os.path.dirname(dir_to_look_for)
        if os.path.isdir(parent_dir):
            for file in os.listdir(parent_dir):
                if file.endswith('.gguf'):
                    return True
        return os.path.exists(dir_to_look_for)
    else:
        dir_to_look_for = os.path.join(model_path, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def check_openvino_model_exists(type: str, repo_id: str) -> bool:
    """Check if an OpenVINO model exists"""
    folder_name = repo_local_root_dir_name(repo_id)
    dir = config.openvino_model_paths.get(type)
    return os.path.exists(os.path.join(dir, folder_name))

def check_llama_cpp_model_exists(type: str, repo_id: str) -> bool:
    """Check if a LlamaCPP model exists"""
    model_dir = config.llama_cpp_model_paths.get(type)
    dir_to_look_for = os.path.join(model_dir, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def check_comfyui_model_exists(type: str, repo_id: str) -> bool:
    """Check if a ComfyUI model exists"""
    model_dir = config.comfy_ui_model_paths.get(type)
    if type == 'faceswap' or type == 'facerestore':
        dir_to_look_for = os.path.join(model_dir, flat_repo_local_dir_name(repo_id))
    elif type == 'nsfwdetector':
        dir_to_look_for = os.path.join(model_dir, 'vit-base-nsfw-detector', extract_model_id_pathsegments(repo_id))
    else:
        dir_to_look_for = os.path.join(model_dir, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
    return os.path.exists(dir_to_look_for)

def check_defaultbackend_mmodel_exist(type: str, repo_id: str) -> bool:
    """Check if a default backend model exists"""
    # Default backend (old ipexllm) is no longer supported
    # This function is kept for backward compatibility but always returns False
    logging.warning(f'Default backend (ipexllm) is no longer supported. Model {repo_id} of type {type} cannot be checked.')
    return False

# File operations
def calculate_sha256(file_path: str):
    """Calculate the SHA256 hash of a file"""
    with open(file_path, "rb") as f:
        file_hash = hashlib.sha256()
        while chunk := f.read(8192):
            file_hash.update(chunk)
    return file_hash.hexdigest()

def create_cache_path(sha256: str, file_size: int):
    """Create a cache path for a file based on its SHA256 hash and size"""
    cache_dir = "./cache"
    sub_dirs = [sha256[i : i + 4] for i in range(0, len(sha256), 4)]
    cache_path = os.path.abspath(
        os.path.join(cache_dir, *sub_dirs, f"{sha256}_{file_size}")
    )
    return cache_path

def cache_file(file_path: IO[bytes] | str, file_size: int):
    """Cache a file using its SHA256 hash and size"""
    sha256 = calculate_sha256(file_path)

    cache_path = create_cache_path(sha256, file_size)

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

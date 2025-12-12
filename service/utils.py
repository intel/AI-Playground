import hashlib
import logging
import os
import shlex
import shutil
import subprocess
from typing import IO, List, Optional

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

def is_specific_file_reference(repo_id: str) -> bool:
    """Check if repo_id references a specific file (has file extension)"""
    return repo_id.endswith(('.gguf', '.safetensors', '.bin', '.pt', '.pth'))

def get_comfyui_faceswap_facerestore_path(type: str, repo_id: str) -> str:
    """
    Get the ComfyUI directory path for a faceswap or facerestore model.
    
    Args:
        type: Model type ('faceswap' or 'facerestore')
        repo_id: Repository ID of the model
    
    Returns:
        Absolute path to the model in ComfyUI's models directory
    """
    if type not in ('faceswap', 'facerestore'):
        raise ValueError(f'Invalid type for ComfyUI path: {type}')
    
    comfy_ui_root = os.path.abspath(config.comfy_ui_root_path)
    flat_name = flat_repo_local_dir_name(repo_id)
    
    if type == 'faceswap':
        return os.path.join(comfy_ui_root, 'models', 'insightface', flat_name)
    else:  # facerestore
        return os.path.join(comfy_ui_root, 'models', 'facerestore_models', flat_name)

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
    """Check if a model exists at the given path, and restore to ComfyUI if needed for faceswap/facerestore"""
    # Resolve absolute path
    model_path = os.path.abspath(model_path)
    
    if type == 'faceswap' or type == 'facerestore':
        storage_path = os.path.join(model_path, flat_repo_local_dir_name(repo_id))
        
        # Check if model exists in storage
        if not os.path.exists(storage_path):
            return False
        
        # For faceswap/facerestore, also check and restore to ComfyUI directory
        comfy_ui_path = get_comfyui_faceswap_facerestore_path(type, repo_id)
        
        # If not in ComfyUI directory, restore from storage
        if not os.path.exists(comfy_ui_path):
            logging.info(f'Restoring {type} model {repo_id} from storage to ComfyUI directory')
            copy_faceswap_facerestore_to_comfyui(type, repo_id, model_path)
        
        return True
    elif type == 'nsfwdetector':
        dir_to_look_for = os.path.join(model_path, 'vit-base-nsfw-detector', extract_model_id_pathsegments(repo_id))
    elif type == 'ggufLLM' or (isinstance(repo_id, str) and repo_id.endswith('.gguf')):
        # For GGUF files, distinguish between specific file references and repo-only references
        dir_to_look_for = os.path.join(model_path, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
        
        # Check if repo_id specifies a specific file
        if is_specific_file_reference(repo_id):
            # For specific file references, check for exact file match
            return os.path.isfile(dir_to_look_for)
        else:
            # For repo-only references, check if any .gguf file exists in the directory
            if os.path.isdir(dir_to_look_for):
                for file in os.listdir(dir_to_look_for):
                    if file.endswith('.gguf'):
                        return True
            return False
    else:
        # For other model types, apply the same logic
        dir_to_look_for = os.path.join(model_path, repo_local_root_dir_name(repo_id), extract_model_id_pathsegments(repo_id))
        
        # Check if repo_id specifies a specific file
        if is_specific_file_reference(repo_id):
            # For specific file references, check for exact file match
            return os.path.isfile(dir_to_look_for)
        else:
            # For repo-only references, check if directory exists
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
    """Check if a ComfyUI model exists, and restore from storage if missing in ComfyUI directory"""
    # For faceswap and facerestore, check ComfyUI's models directory first
    if type == 'faceswap' or type == 'facerestore':
        # Check ComfyUI's models directory first
        comfy_ui_path = get_comfyui_faceswap_facerestore_path(type, repo_id)
        
        # If exists in ComfyUI directory, return True
        if os.path.exists(comfy_ui_path):
            return True
        
        # If not in ComfyUI directory, check storage and restore if found
        model_dir = config.comfy_ui_model_paths.get(type)
        flat_name = flat_repo_local_dir_name(repo_id)
        storage_path = os.path.join(os.path.abspath(model_dir), flat_name)
        
        if os.path.exists(storage_path):
            # Restore from storage to ComfyUI directory
            logging.info(f'Restoring {type} model {repo_id} from storage to ComfyUI directory')
            if copy_faceswap_facerestore_to_comfyui(type, repo_id):
                return True
            else:
                # Even if copy failed, model exists in storage
                logging.warning(f'Model exists in storage but failed to copy to ComfyUI: {repo_id}')
                return True  # Return True because model exists, just not in ComfyUI location
        
        return False
    elif type == 'nsfwdetector':
        dir_to_look_for = os.path.join(config.comfy_ui_model_paths.get(type), 'vit-base-nsfw-detector', extract_model_id_pathsegments(repo_id))
    else:
        model_dir = config.comfy_ui_model_paths.get(type)
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

def copy_faceswap_facerestore_to_comfyui(type: str, repo_id: str, storage_model_path: str = None) -> bool:
    """
    Copy faceswap or facerestore models from our storage location to ComfyUI's models directory.
    
    Args:
        type: Model type ('faceswap' or 'facerestore')
        repo_id: Repository ID of the model
        storage_model_path: Optional path to the storage location (defaults to config path)
    
    Returns:
        True if copy was successful, False otherwise
    """
    if type not in ('faceswap', 'facerestore'):
        logging.warning(f'copy_faceswap_facerestore_to_comfyui called for unsupported type: {type}')
        return False
    
    try:
        # Get storage path (where models are downloaded)
        if storage_model_path:
            storage_path = os.path.abspath(storage_model_path)
        else:
            storage_path = os.path.abspath(config.comfy_ui_model_paths.get(type))
        
        # Construct source and destination paths
        flat_name = flat_repo_local_dir_name(repo_id)
        source_path = os.path.join(storage_path, flat_name)
        dest_path = get_comfyui_faceswap_facerestore_path(type, repo_id)
        dest_dir = os.path.dirname(dest_path)
        
        # Check if source exists
        if not os.path.exists(source_path):
            logging.warning(f'Source model not found at {source_path}, cannot copy to ComfyUI')
            return False
        
        # Create destination directory if it doesn't exist
        os.makedirs(dest_dir, exist_ok=True)
        
        # Remove existing destination if it exists
        if os.path.exists(dest_path):
            if os.path.isdir(dest_path):
                shutil.rmtree(dest_path)
            else:
                os.remove(dest_path)
        
        # Copy model (file or directory)
        if os.path.isdir(source_path):
            shutil.copytree(source_path, dest_path)
            logging.info(f'Copied directory {source_path} to {dest_path}')
        else:
            shutil.copy2(source_path, dest_path)
            logging.info(f'Copied file {source_path} to {dest_path}')
        
        return True
    except Exception as e:
        logging.error(f'Failed to copy {type} model {repo_id} to ComfyUI: {e}')
        return False

# Subprocess utilities
def call_subprocess(process_command: str, cwd: Optional[str] = None) -> str:
    """Execute a subprocess command and return its output"""
    args = shlex.split(process_command)
    try:
        logging.info(f"calling cmd process: {args}")
        output = subprocess.check_output(args, cwd=cwd, env={**os.environ, "PIP_CONFIG_FILE": os.devnull})
        return output.decode("utf-8").strip()
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to call subprocess {process_command} with error {e}")
        raise e

import os
import logging
import subprocess
import shlex
from typing import Optional

# Import from the shared modules
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
is_single_file = utils.is_single_file
remove_existing_filesystem_resource = utils.remove_existing_filesystem_resource

def call_subprocess(process_command: str, cwd: Optional[str] = None) -> str:
    args = shlex.split(process_command)
    try:
        logging.info(f"calling cmd process: {args}")
        output = subprocess.check_output(args, cwd=cwd, env={**os.environ, "PIP_CONFIG_FILE": os.devnull})
        return output.decode("utf-8").strip()
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to call subprocess {process_command} with error {e}")
        raise e

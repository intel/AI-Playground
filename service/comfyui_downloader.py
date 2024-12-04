import logging
import os
import sys

import requests

import aipg_utils
import service_config
from web_request_bodies import ComfyUICustomNodesGithubRepoId


git_download_url = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/PortableGit-2.47.1-64-bit.7z.exe"
comfyUI_git_repo_url = "https://github.com/comfyanonymous/ComfyUI.git"
comfyUI_manager_git_repo_url = "https://github.com/ltdrdata/ComfyUI-Manager.git"

def is_comfyUI_installed() -> bool:
    return os.path.exists(service_config.comfyUIRootPath)

def is_git_installed() -> bool:
    return os.path.exists(service_config.git.get("rootDirPath"))

def _install_portable_git():
    if is_git_installed():
        logging.info("Omitting installation of git, as already present")
        return
    seven_zipped_portable_git_target = f"{service_config.git.get('rootDirPath')}.7z"
    git_target_dir = service_config.git.get('rootDirPath')

    try:
        aipg_utils.remove_existing_filesystem_resource(seven_zipped_portable_git_target)
        aipg_utils.remove_existing_filesystem_resource(git_target_dir)

        _fetch_portable_git(seven_zipped_portable_git_target)
        _unzip_portable_git(seven_zipped_portable_git_target, git_target_dir)
        assert is_git_installed(), "Failed to install git at expected location"
    except Exception as e:
        logging.error(f"failed to install git due to {e}. Cleaning up intermediate resources")
        aipg_utils.remove_existing_filesystem_resource(seven_zipped_portable_git_target)
        aipg_utils.remove_existing_filesystem_resource(git_target_dir)
        raise e


def _fetch_portable_git(seven_zipped_portable_git_target):
    try:
        response = requests.get(git_download_url, stream=True)
        if response.status_code == 200:
            with open(seven_zipped_portable_git_target, "wb") as file:
                for chunk in response.iter_content(chunk_size=1024):
                    file.write(chunk)
        else:
            print("Failed to download file")
            #TODO: raise exception
    except Exception as e:
        logging.error(f"Failed to fetch portable git from ${git_download_url} with error {e}")
        aipg_utils.remove_existing_filesystem_resource(seven_zipped_portable_git_target)
        raise e


def _unzip_portable_git(zipped_git_path, target_dir):
    try:
        unzipping_command = f"{service_config.seven_z_exe_path} x -o{target_dir} {zipped_git_path}"
        aipg_utils.call_subprocess(unzipping_command)
    except Exception as e:
        aipg_utils.remove_existing_filesystem_resource(zipped_git_path)
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        raise e

def _install_git_repo(git_repo_url: str, target_dir: str):
    try:
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        aipg_utils.call_subprocess(f"{service_config.git.get('exePath')} clone {git_repo_url} {target_dir}")
    except Exception as e:
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        raise e

def _install_pip_requirements(requirements_txt_path: str):
    if (os.path.exists(requirements_txt_path)):
        aipg_utils.call_subprocess(f"{sys.executable} -m pip install -r {requirements_txt_path}")
    else:
        logging.warning(f"specified {requirements_txt_path} does not exist.")


def install_comfyUI() -> bool:
    if is_comfyUI_installed():
        logging.info("comfyUI installation requested, while already installed")
        return True
    try:
        _install_portable_git()
        _install_git_repo(comfyUI_git_repo_url, service_config.comfyUIRootPath)
        _install_pip_requirements(os.path.join(service_config.comfyUIRootPath, "requirements.txt"))
        return True
    except Exception as e:
        logging.error(f"comfyUI installation failed due to {e}")
        raise e


def is_custom_node_installed(node_repo_ref: ComfyUICustomNodesGithubRepoId) -> bool:
    expected_custom_node_path = os.path.join(service_config.comfyUIRootPath, "custom_nodes", node_repo_ref.reponame)
    return os.path.exists(expected_custom_node_path)

def download_custom_node(node_repo_data: ComfyUICustomNodesGithubRepoId):
    if is_custom_node_installed(node_repo_data):
        return
    else:
        try:
            expected_git_url = f"https://github.com/{node_repo_data.username}/{node_repo_data.reponame}"
            expected_custom_node_path = os.path.join(service_config.comfyUIRootPath, "custom_nodes", node_repo_data.reponame)
            potential_node_requirements = os.path.join(expected_custom_node_path, "requirements.txt")

            _install_git_repo(expected_git_url, expected_custom_node_path)
            _install_pip_requirements(potential_node_requirements)
            logging.error(f"Failed to install custom comfy node {node_repo_data.username}/{node_repo_data.reponame} due to {e}")

            return
        except Exception as e:
            logging.error(f"Failed to install custom comfy node {node_repo_data.username}/{node_repo_data.reponame} due to {e}")
            raise e

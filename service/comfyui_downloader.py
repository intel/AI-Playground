import logging
import os
import sys
from typing import Optional

import requests

import aipg_utils
import service_config
from web_request_bodies import ComfyUICustomNodesGithubRepoId


git_download_url = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip"
comfyUI_git_repo_url = "https://github.com/comfyanonymous/ComfyUI.git"
comfyUI_manager_git_repo_url = "https://github.com/ltdrdata/ComfyUI-Manager.git"

def is_comfyUI_installed() -> bool:
    return os.path.exists(service_config.comfy_ui_root_path)

def is_git_installed() -> bool:
    return os.path.exists(service_config.git.get("rootDirPath"))

def _install_portable_git():
    if is_git_installed():
        logging.info("Omitting installation of git, as already present")
        return
    zipped_portable_git_target = f"{service_config.git.get('rootDirPath')}.zip"
    git_target_dir = service_config.git.get('rootDirPath')

    try:
        aipg_utils.remove_existing_filesystem_resource(zipped_portable_git_target)
        aipg_utils.remove_existing_filesystem_resource(git_target_dir)

        _fetch_portable_git(zipped_portable_git_target)
        _unzip_portable_git(zipped_portable_git_target, git_target_dir)
        if not is_git_installed():
            raise AssertionError("Failed to install git at expected location")
        logging.info(f"successfully extracted git into {os.path.abspath(git_target_dir)}")
    except Exception as e:
        logging.error(f"failed to install git due to {e}. Cleaning up intermediate resources")
        aipg_utils.remove_existing_filesystem_resource(zipped_portable_git_target)
        aipg_utils.remove_existing_filesystem_resource(git_target_dir)
        raise e


def _fetch_portable_git(seven_zipped_portable_git_target):
    try:
        response = requests.get(git_download_url, stream=True, timeout=30)
        if response.status_code == 200:
            with open(seven_zipped_portable_git_target, "wb") as file:
                for chunk in response.iter_content(chunk_size=1024):
                    file.write(chunk)
        else:
            logging.error(f"Failed fetching resources from {git_download_url}")
            raise Exception(f"fetching {git_download_url} failed with response: {response}")
    except Exception as e:
        logging.error(f"Failed to fetch portable git from {git_download_url} with error {e}")
        aipg_utils.remove_existing_filesystem_resource(seven_zipped_portable_git_target)
        raise e


def _unzip_portable_git(zipped_git_path, target_dir):
    def get_unzipping_command():
        try:
            aipg_utils.call_subprocess("tar --version")
            logging.debug("using system tar to unzip.")
            return f"tar -C {target_dir} -xf {zipped_git_path}"
        except Exception:
            logging.warning("falling back to powershell command to extract zip, as tar not in PATH")
            return f"powershell -command 'Expand-Archive' -Force {zipped_git_path} {target_dir}"
    try:
        if not os.path.exists(target_dir):
            os.makedirs(target_dir, exist_ok=True)
        aipg_utils.call_subprocess(get_unzipping_command())
        logging.info("Unzipped git successfully")
    except Exception as e:
        aipg_utils.remove_existing_filesystem_resource(zipped_git_path)
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        raise e

def _install_git_repo(git_repo_url: str, target_dir: str):
    try:
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        aipg_utils.call_subprocess(f"{service_config.git.get('exePath')} clone {git_repo_url} '{target_dir}'")
        logging.info(f"Cloned {git_repo_url} into {target_dir}")
    except Exception as e:
        logging.warning(f"git cloned failed with exception {e}. Cleaning up failed resources.")
        aipg_utils.remove_existing_filesystem_resource(target_dir)
        raise e

def _checkout_git_ref(repo_dir: str, git_ref: Optional[str]):
    if git_ref is None or not git_ref.strip():
        logging.info(f"No valid git ref provided for {repo_dir}")
        logging.warning(f"Repo {repo_dir} remains in ref {get_git_ref(repo_dir)}.")
        return
    try:
        aipg_utils.call_subprocess(f"{service_config.git.get('exePath')} checkout {git_ref}", cwd=repo_dir)
        logging.info(f"checked out {git_ref} in {repo_dir}")
    except Exception as e:
        logging.warning(f"git checkout of {git_ref} failed for rep {repo_dir} due to {e}.")
        logging.warning(f"Repo {repo_dir} remains in ref {get_git_ref(repo_dir)}.")


def get_git_ref(repo_dir: str) -> Optional[str]:
    try:
        git_ref = aipg_utils.call_subprocess(f"{service_config.git.get('exePath')} rev-parse HEAD", cwd=repo_dir)
        return git_ref
    except Exception as e:
        logging.warning(f"Resolving git ref in {repo_dir} failed due to {e}")
        return


def _install_pip_requirements(requirements_txt_path: str):
    logging.info(f"installing python requirements from {requirements_txt_path} using {sys.executable}")
    if os.path.exists(requirements_txt_path):
        python_exe_callable_path = "'" + os.path.abspath(service_config.comfyui_python_exe) + "'" # this returns the abs path and may contain spaces. Escape the spaces with "ticks"
        aipg_utils.call_subprocess(f"{python_exe_callable_path} -m pip install -r '{requirements_txt_path}'")
        logging.info("python requirements installation completed.")
    else:
        logging.warning(f"specified {requirements_txt_path} does not exist.")


def install_pypi_package(packageSpecifier: str):
    installed_packages = aipg_utils.call_subprocess(f"{service_config.comfyui_python_exe} -m pip list")
    if packageSpecifier.endswith(".whl"):
        package_name = packageSpecifier.split("/")[-1].split("-")[0]
    else:
        package_name = packageSpecifier.split("==")[0]
    if package_name in installed_packages:
        logging.info(f"package {package_name} already installed. Omitting installation")
        return
    if packageSpecifier.endswith(".whl"):
        pip_specifier = os.path.abspath(os.path.join(service_config.comfyui_python_env, packageSpecifier.split("/")[-1]))
        try:
            response = requests.get(packageSpecifier, stream=True, timeout=30)
            if response.status_code == 200:
                with open(pip_specifier, "wb") as file:
                    for chunk in response.iter_content(chunk_size=1024):
                        file.write(chunk)
            else:
                logging.error(f"Failed fetching resources from {packageSpecifier}")
                raise Exception(f"fetching {packageSpecifier} failed with response: {response}")
        except Exception as e:
            logging.error(f"Failed to fetch dependency from {packageSpecifier} with error {e}")
            raise e
    else:
        pip_specifier = packageSpecifier

    logging.info(f"installing python package {packageSpecifier} using {sys.executable}")
    python_exe_callable_path = "'" + os.path.abspath(service_config.comfyui_python_exe) + "'" # this returns the abs path and may contain spaces. Escape the spaces with "ticks"
    aipg_utils.call_subprocess(f"{python_exe_callable_path} -m pip install '{pip_specifier}'")
    aipg_utils.remove_existing_filesystem_resource('./dep.whl')
    logging.info("python package installation completed.")


def install_comfyUI() -> bool:
    if is_comfyUI_installed():
        logging.info("comfyUI installation requested, while already installed")
        return True
    try:
        _install_portable_git()
        _install_git_repo(comfyUI_git_repo_url, service_config.comfy_ui_root_path)
        _install_pip_requirements(os.path.join(service_config.comfy_ui_root_path, "requirements.txt"))
        return True
    except Exception as e:
        logging.error(f"comfyUI installation failed due to {e}")
        if os.path.exists(service_config.comfy_ui_root_path):
            aipg_utils.remove_existing_filesystem_resource(service_config.comfy_ui_root_path)
        raise e


def is_custom_node_installed_with_git_ref(node_repo_ref: ComfyUICustomNodesGithubRepoId) -> bool:
    expected_custom_node_path = os.path.join(service_config.comfy_ui_root_path, "custom_nodes", node_repo_ref.repoName)
    custom_node_dir_exists = os.path.exists(expected_custom_node_path)

    return custom_node_dir_exists


def download_custom_node(node_repo_data: ComfyUICustomNodesGithubRepoId) -> bool:
    if is_custom_node_installed_with_git_ref(node_repo_data):
        logging.info(f"node repo {node_repo_data} already exists. Omitting")
        return True
    else:
        try:
            expected_git_url = f"https://github.com/{node_repo_data.username}/{node_repo_data.repoName}"
            expected_custom_node_path = os.path.join(service_config.comfy_ui_root_path, "custom_nodes", node_repo_data.repoName)
            potential_node_requirements = os.path.join(expected_custom_node_path, "requirements.txt")

            aipg_utils.remove_existing_filesystem_resource(expected_custom_node_path)
            _install_git_repo(expected_git_url, expected_custom_node_path)
            _checkout_git_ref(expected_custom_node_path, node_repo_data.gitRef)
            _install_pip_requirements(potential_node_requirements)
            return True
        except Exception as e:
            logging.error(f"Failed to install custom comfy node {node_repo_data.username}/{node_repo_data.repoName} due to {e}")
            return False

import logging
import os
import sys
from typing import Optional

import requests

import aipg_utils
import service_config
from web_request_bodies import ComfyUICustomNodesGithubRepoId


def is_comfyUI_installed() -> bool:
    return os.path.exists(service_config.comfy_ui_root_path)


def is_git_installed() -> bool:
    return os.path.exists(service_config.git.get("rootDirPath"))


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
    if is_package_installed(packageSpecifier):
        logging.info(f"package {packageSpecifier} already installed. Omitting installation")
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


def is_package_installed(packageSpecifier: str):
    installed_packages = aipg_utils.call_subprocess(f"{service_config.comfyui_python_exe} -m pip list")
    if packageSpecifier.endswith(".whl"):
        package_name = packageSpecifier.split("/")[-1].split("-")[0]
    else:
        package_name = packageSpecifier.split("==")[0]
    if package_name in installed_packages:
        return True
    return False


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
            _patch_custom_node_if_required(expected_custom_node_path, node_repo_data)
            _install_pip_requirements(potential_node_requirements)
            return True
        except Exception as e:
            logging.error(f"Failed to install custom comfy node {node_repo_data.username}/{node_repo_data.repoName} due to {e}")
            return False


# Gourieff/ComfyUI-ReActor/scripts/reactor_sfw.py
REACTOR_SFW_PATCH = """from transformers import pipeline
from PIL import Image
import logging

SCORE = 0.965 # 0.965 and less - is safety content

logging.getLogger('transformers').setLevel(logging.ERROR)
from scripts.reactor_logger import logger

def nsfw_image(img_path: str, model_path: str):
    with Image.open(img_path) as img:
        predict = pipeline("image-classification", model=model_path)
        result = predict(img)
        logger.status(result)
        # Find the element with 'nsfw' label
        for item in result:
            if item["label"] == "nsfw":
                # Return True if nsfw score is above threshold (indicating NSFW content)
                # Return False if nsfw score is below threshold (indicating safe content)
                return True if item["score"] > SCORE else False
        # If no 'nsfw' label found, consider it safe
        return False
"""


def _patch_custom_node_if_required(custom_node_path: str, node_repo_data: ComfyUICustomNodesGithubRepoId):
    if f"{node_repo_data.username}/{node_repo_data.repoName}@{node_repo_data.gitRef}".lower() == "Gourieff/comfyui-reactor@d2318ad140582c6d0b68c51df342319b502006ed".lower():
        reactor_sfw_path = os.path.join(custom_node_path, "scripts", "reactor_sfw.py")
        with open(reactor_sfw_path, "w") as file:
            file.write(REACTOR_SFW_PATCH)
        logging.info(f"patched {reactor_sfw_path} with custom logic")

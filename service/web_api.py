import sys
import time

added = []
def auditor(event, args):
    if event == "os.add_dll_directory":
        (path,) = args
        added.append({"ts": time.time(), "path": str(path)})

try:
    sys.addaudithook(auditor)
except Exception:
    pass

def get_added_dll_directories():
    # helper for your logs
    # de-dup while preserving first-seen order
    seen, out = set(), []
    for rec in added:
        p = rec["path"]
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out

try:
    import sys

    import comfyui_downloader
    from web_request_bodies import ComfyUICheckWorkflowRequirementRequest, DownloadModelRequestBody, ComfyUICustomNodesDownloadRequest, ComfyUIPackageInstallRequest
    from device_utils import get_device_info, detect_all_available_devices


    # Credit to https://github.com/AUTOMATIC1111/stable-diffusion-webui/pull/14186
    # Related issues:
    # + https://github.com/XPixelGroup/BasicSR/issues/649
    # + https://github.com/AUTOMATIC1111/stable-diffusion-webui/issues/13985
    try:
        import torchvision.transforms.functional_tensor  # noqa: F401
    except ImportError:
        try:
            import torchvision.transforms.functional as functional

            sys.modules["torchvision.transforms.functional_tensor"] = functional
        except ImportError:
            pass

    import os
    import threading
    from flask import jsonify, request, Response, stream_with_context
    from apiflask import APIFlask

    import model_download_adpater
    import utils
    from model_downloader import HFPlaygroundDownloader
    from psutil._common import bytes2human
    import traceback
    import logging
    logging.basicConfig(stream=sys.stdout, level=logging.INFO)

    app = APIFlask(__name__)

    @app.get("/healthy")
    def healthEndpoint():
        return jsonify({"health": "OK"})

    @app.get("/api/devices")
    def get_devices():
        """
        Get all available devices (XPU, CUDA, CPU) with their details.
        Frontend can use this to let users select their preferred device.
        """
        try:
            device_info = get_device_info()
            return jsonify({
                "code": 0,
                "message": "success",
                "data": device_info
            })
        except Exception as e:
            logging.error(f"Error getting device info: {e}")
            return jsonify({
                "code": 1,
                "message": f"Failed to get device info: {str(e)}",
                "data": None
            }), 500

    @app.get("/api/applicationExit")
    def applicationExit():
        from signal import SIGINT

        pid = os.getpid()
        os.kill(pid, SIGINT)

    @app.post("/api/checkModelAlreadyLoaded")
    @app.input(DownloadModelRequestBody.Schema, location='json', arg_name='download_request_data')
    def check_model_already_loaded(download_request_data: DownloadModelRequestBody):
        result_list = []
        for item in download_request_data.data:
            base_response = {
                "repo_id": item.repo_id,
                "type": item.type,
                "backend": item.backend,
                "already_loaded": utils.check_mmodel_exist(item.type, item.repo_id, item.backend, item.model_path),
            }

            if (item.additionalLicenseLink is not None):
                base_response['additionalLicenseLink'] = item.additionalLicenseLink

            result_list.append(base_response)
        return jsonify({"code": 0, "message": "success", "data": result_list})



    @app.get("/api/checkHFRepoExists")
    def check_if_huggingface_repo_exists():
        repo_id = request.args.get('repo_id')
        downloader = HFPlaygroundDownloader()
        exists = downloader.hf_url_exists(repo_id)
        return jsonify(
            {
                "exists": exists
            }
        )


    size_cache = dict()
    lock = threading.Lock()


    @app.post("/api/isModelGated")
    def is_model_gated():
        list = request.get_json()
        downloader = HFPlaygroundDownloader()
        gated = {item["repo_id"]: downloader.is_gated(item["repo_id"]) for item in list}

        return jsonify(
            {
                "code": 0,
                "message": "success",
                "gatedList": gated,
            }
        )

    @app.route("/api/isAccessGranted", methods=["POST"])
    def is_access_granted():
        list, hf_token = request.get_json()
        downloader = HFPlaygroundDownloader(hf_token)
        accessGranted = { item["repo_id"] : downloader.is_access_granted(item["repo_id"], item["type"], item["backend"]) for item in list }
        return jsonify(
            {
                "accessList": accessGranted
            }
        )

    @app.post("/api/getModelSize")
    def get_model_size():
        import concurrent.futures

        list = request.get_json()
        result_dict = dict()
        request_list = []
        for item in list:
            repo_id = item["repo_id"]
            type = item["type"]
            key = f"{repo_id}_{type}"
            total_size = size_cache.get(key)
            if total_size is None:
                request_list.append((repo_id, type))
            else:
                result_dict.__setitem__(
                    key, bytes2human(total_size, "%(value).2f%(symbol)s")
                )

        if request_list.__len__() > 0:
            with concurrent.futures.ThreadPoolExecutor() as executor:
                futures = [
                    executor.submit(fill_size_execute, repo_id, type, result_dict)
                    for repo_id, type in request_list
                ]
                concurrent.futures.wait(futures)
                executor.shutdown()

        return jsonify(
            {
                "code": 0,
                "message": "success",
                "sizeList": result_dict,
            }
        )


    def fill_size_execute(repo_id: str, type: int, result_dict: dict):
        key = f"{repo_id}_{type}"
        total_size = HFPlaygroundDownloader().get_model_total_size(repo_id, type)
        with lock:
            size_cache.__setitem__(key, total_size)
            result_dict.__setitem__(key, bytes2human(total_size, "%(value).2f%(symbol)s"))




    def get_bearer_token(request):
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            return auth_header.split(" ")[1]
        return None


    @app.post("/api/downloadModel")
    @app.input(DownloadModelRequestBody.Schema, location='json', arg_name='download_request_data')
    def download_model(download_request_data: DownloadModelRequestBody):
        if model_download_adpater._adapter is not None:
            model_download_adpater._adapter.stop_download()
        try:
            model_download_adpater._adapter = (
                model_download_adpater.Model_Downloader_Adapter(
                    hf_token=get_bearer_token(request)
                )
            )
            iterator = model_download_adpater._adapter.download(download_request_data.data)
            return Response(stream_with_context(iterator), content_type="text/event-stream")
        except Exception as e:
            traceback.print_exc()

            model_download_adpater._adapter.stop_download()
            ex_str = '{{"type": "error", "err_type": "{}"}}'.format(e)
            return Response(stream_with_context([ex_str]), content_type="text/event-stream")


    @app.get("/api/stopDownloadModel")
    def stop_download_model():
        if model_download_adpater._adapter is not None:
            model_download_adpater._adapter.stop_download()
        return jsonify({"code": 0, "message": "success"})




    @app.post("/api/comfyUi/areCustomNodesLoaded")
    @app.input(ComfyUICustomNodesDownloadRequest.Schema, location='json', arg_name='comfyNodeRequest')
    def are_custom_nodes_installed(comfyNodeRequest: ComfyUICustomNodesDownloadRequest):
        response = { f"{x.username}/{x.repoName}" : comfyui_downloader.is_custom_node_installed_with_git_ref(x) for x in comfyNodeRequest.data}
        return jsonify(response)


    @app.post("/api/comfyUi/loadCustomNodes")
    @app.input(ComfyUICustomNodesDownloadRequest.Schema, location='json', arg_name='comfyNodeRequest')
    def install_custom_nodes(comfyNodeRequest: ComfyUICustomNodesDownloadRequest):
        try:
            nodes_to_be_installed = [x for x in comfyNodeRequest.data if not comfyui_downloader.is_custom_node_installed_with_git_ref(x)]
            installation_result = [ {"node": f"{x.username}/{x.repoName}", "success": comfyui_downloader.download_custom_node(x)} for x in nodes_to_be_installed ]
            logging.info(f"custom node installation request result: {installation_result}")
            return jsonify(installation_result)
        except Exception as e:
            return jsonify({'error_message': f'failed to install at least one custom node due to {e}'}), 501


    @app.post("/api/comfyUi/installPythonPackage")
    @app.input(ComfyUIPackageInstallRequest.Schema, location='json', arg_name='comfyPackageInstallRequest')
    def install_python_packages_for_comfy(comfyPackageInstallRequest: ComfyUIPackageInstallRequest):
        try:
            for package in comfyPackageInstallRequest.data:
                comfyui_downloader.install_pypi_package(package)
            return jsonify({ f"{package}" : {"success": True, "errorMessage": ""} for x in comfyPackageInstallRequest.data})
        except Exception as e:
            return jsonify({'error_message': f'failed to at least one package due to {e}'}), 501

    @app.post("/api/comfyUi/checkWorkflowRequirements")
    @app.input(ComfyUICheckWorkflowRequirementRequest.Schema , location='json', arg_name='comfyRequirementRequest')
    def check_workflow_requirements(comfyRequirementRequest: ComfyUICheckWorkflowRequirementRequest):
        try:
            nodes_to_be_installed = [not comfyui_downloader.is_custom_node_installed_with_git_ref(x) for x in comfyRequirementRequest.customNodes]
            packages_to_be_installed = [not comfyui_downloader.is_package_installed(x) for x in comfyRequirementRequest.pythonPackages]
            needs_installation = any(nodes_to_be_installed) or any(packages_to_be_installed)
            return jsonify({'needsInstallation' : needs_installation})
        except Exception as e:
            return jsonify({'errorMessage': f'failed to check for installation {e}'}), 500


    if __name__ == "__main__":
        import argparse

        parser = argparse.ArgumentParser(description="AI Playground Web service")
        parser.add_argument("--port", type=int, default=59999, help="Service listen port")
        args = parser.parse_args()
        app.run(host="127.0.0.1", port=args.port)

except OSError as e:
    import os
    import sys
    import psutil
    import json
    info = {
        "errno": getattr(e, "errno", None),
        "winerror": getattr(e, "winerror", None),
        "filename": getattr(e, "filename", None),
        "python": sys.version,
        "bits": 64 if sys.maxsize > 2**32 else 32,
        "exe": sys.executable,
        "cwd": os.getcwd(),
        "module_dir": os.path.dirname(__file__),
        "dll_dirs": get_added_dll_directories(),
        "loaded_modules": [m.path for m in psutil.Process().memory_maps() if m.path.lower().endswith((".dll",".pyd"))],
    }
    e.add_note(json.dumps(info, indent=2))
    raise
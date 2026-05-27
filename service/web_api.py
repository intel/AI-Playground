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

    from web_request_bodies import (
        DownloadModelRequestBody,
    )

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

    import hmac
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

    # Per-launch loopback auth token, passed in by the AI Playground Electron
    # main process via env var. Without this, the local 127.0.0.1:5xxxx port
    # would be reachable by any other process on the box (including low-IL
    # processes and host-networked containers), which is the attack model
    # documented in the CWE-494 report against /api/comfyUi/loadCustomNodes.
    _LOOPBACK_AUTH_TOKEN = os.environ.get("AIPG_LOOPBACK_TOKEN", "")
    _LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})
    # Endpoints that are allowed without a bearer token. /healthy must remain
    # reachable so the Electron service registry can detect when the service
    # is up before it has obtained the token.
    _AUTH_EXEMPT_PATHS = frozenset({"/healthy"})
    # Loopback hostnames whose Origin we are willing to echo back as
    # Access-Control-Allow-Origin. The renderer may load via 127.0.0.1 or
    # localhost depending on platform/devtools; production Electron loads
    # from file:// which the browser sends as `Origin: null`.
    _ALLOWED_CORS_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})

    if not _LOOPBACK_AUTH_TOKEN:
        logging.warning(
            "AIPG_LOOPBACK_TOKEN env var is not set; ai-backend will reject all "
            "non-/healthy requests. Start the service via the AI Playground "
            "Electron main process so the token is provisioned."
        )

    def _origin_is_loopback(origin: str) -> bool:
        """True for `null`, `file://...`, or any http(s) URL whose host is a
        loopback host. Used to decide whether we are willing to echo the
        request Origin back as Access-Control-Allow-Origin."""
        if not origin:
            return False
        if origin == "null":
            return True
        if origin.startswith("file://"):
            return True
        # Strip scheme.
        for scheme in ("http://", "https://"):
            if origin.startswith(scheme):
                rest = origin[len(scheme) :]
                # Strip path component if any.
                rest = rest.split("/", 1)[0]
                # Strip port. IPv6 hosts come bracketed: `[::1]:1234`.
                if rest.startswith("["):
                    end = rest.find("]")
                    if end < 0:
                        return False
                    host = rest[: end + 1]
                else:
                    host = rest.split(":", 1)[0]
                return host in _ALLOWED_CORS_HOSTS
        return False

    @app.before_request
    def _enforce_loopback_and_auth():
        if request.remote_addr not in _LOOPBACK_REMOTE_ADDRS:
            logging.warning(
                f"rejecting non-loopback request from {request.remote_addr} to {request.path}"
            )
            return jsonify({"error": "loopback only"}), 403
        # CORS preflight requests do NOT carry the X-AIPG-Auth header by
        # design (the browser strips custom headers from preflight). Reply
        # 204 here and let _attach_cors_headers below add the actual CORS
        # headers; the real request that follows will be authenticated.
        if request.method == "OPTIONS":
            return Response(status=204)
        if request.path in _AUTH_EXEMPT_PATHS:
            return None
        if not _LOOPBACK_AUTH_TOKEN:
            return jsonify({"error": "service not provisioned"}), 503
        # Use a dedicated X-AIPG-Auth header so the existing
        # `Authorization: Bearer <hf_token>` semantics for /api/downloadModel
        # remain intact.
        provided = request.headers.get("X-AIPG-Auth", "")
        if not provided or not hmac.compare_digest(provided, _LOOPBACK_AUTH_TOKEN):
            return jsonify({"error": "unauthorized"}), 401
        return None

    @app.after_request
    def _attach_cors_headers(response):
        # The renderer fetch sends a custom `X-AIPG-Auth` header which makes
        # the request "non-simple", so the browser issues a CORS preflight
        # for every call. We only echo the Origin back when it is a known
        # loopback origin; non-loopback origins get no Allow-Origin header
        # and the browser blocks them.
        origin = request.headers.get("Origin", "")
        if origin and _origin_is_loopback(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = (
                "GET, POST, DELETE, PUT, OPTIONS, PATCH"
            )
            response.headers["Access-Control-Allow-Headers"] = (
                "Content-Type, Authorization, X-AIPG-Auth"
            )
            # Preflight result cached for 10 minutes; avoids repeated OPTIONS
            # round-trips for typical short-lived API calls.
            response.headers["Access-Control-Max-Age"] = "600"
        return response

    @app.get("/healthy")
    def healthEndpoint():
        return jsonify({"health": "OK"})

    @app.post("/api/checkModelAlreadyLoaded")
    @app.input(
        DownloadModelRequestBody.Schema,
        location="json",
        arg_name="download_request_data",
    )
    def check_model_already_loaded(download_request_data: DownloadModelRequestBody):
        result_list = []
        for item in download_request_data.data:
            base_response = {
                "repo_id": item.repo_id,
                "type": item.type,
                "backend": item.backend,
                "already_loaded": utils.check_mmodel_exist(
                    item.type, item.repo_id, item.backend, item.model_path
                ),
            }

            if item.additionalLicenseLink is not None:
                base_response["additionalLicenseLink"] = item.additionalLicenseLink

            result_list.append(base_response)
        return jsonify({"code": 0, "message": "success", "data": result_list})

    @app.get("/api/checkHFRepoExists")
    def check_if_huggingface_repo_exists():
        repo_id = request.args.get("repo_id")
        # Honor the user's HF token so private/gated repos that the user can
        # actually access are reported as existing. Without this, the renderer
        # would treat a private OVMS image repo as nonexistent and skip the
        # download dialog entirely.
        hf_token = get_bearer_token(request)
        downloader = HFPlaygroundDownloader(hf_token=hf_token)
        exists = downloader.hf_url_exists(repo_id)
        return jsonify({"exists": exists})

    size_cache = dict()
    lock = threading.Lock()

    @app.post("/api/isModelGated")
    def is_model_gated():
        list, hf_token = request.get_json()
        downloader = HFPlaygroundDownloader(hf_token if hf_token else None)
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
        accessGranted = {
            item["repo_id"]: downloader.is_access_granted(
                item["repo_id"], item["type"], item["backend"]
            )
            for item in list
        }
        return jsonify({"accessList": accessGranted})

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
            result_dict.__setitem__(
                key, bytes2human(total_size, "%(value).2f%(symbol)s")
            )

    def get_bearer_token(request):
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            return auth_header.split(" ")[1]
        return None

    @app.post("/api/downloadModel")
    @app.input(
        DownloadModelRequestBody.Schema,
        location="json",
        arg_name="download_request_data",
    )
    def download_model(download_request_data: DownloadModelRequestBody):
        if model_download_adpater._adapter is not None:
            model_download_adpater._adapter.stop_download()
        try:
            model_download_adpater._adapter = (
                model_download_adpater.Model_Downloader_Adapter(
                    hf_token=get_bearer_token(request)
                )
            )
            iterator = model_download_adpater._adapter.download(
                download_request_data.data
            )
            return Response(
                stream_with_context(iterator), content_type="text/event-stream"
            )
        except Exception as e:
            traceback.print_exc()

            model_download_adpater._adapter.stop_download()
            ex_str = '{{"type": "error", "err_type": "{}"}}'.format(e)
            return Response(
                stream_with_context([ex_str]), content_type="text/event-stream"
            )

    @app.get("/api/stopDownloadModel")
    def stop_download_model():
        if model_download_adpater._adapter is not None:
            model_download_adpater._adapter.stop_download()
        return jsonify({"code": 0, "message": "success"})

    if __name__ == "__main__":
        import argparse

        parser = argparse.ArgumentParser(description="AI Playground Web service")
        parser.add_argument(
            "--port", type=int, default=59999, help="Service listen port"
        )
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
        "loaded_modules": [
            m.path
            for m in psutil.Process().memory_maps()
            if m.path.lower().endswith((".dll", ".pyd"))
        ],
    }
    e.add_note(json.dumps(info, indent=2))
    raise

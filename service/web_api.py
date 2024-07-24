from datetime import datetime
import os
import threading
from flask import Flask, jsonify, request, Response, stream_with_context
from llm_adapter import LLM_SSE_Adapter
from sd_adapter import SD_SSE_Adapter
import model_download_adpater
from paint_biz import (
    TextImageParams,
    ImageToImageParams,
    InpaintParams,
    OutpaintParams,
    UpscaleImageParams,
)
import paint_biz
import llm_biz
import utils
import rag
import model_config
from model_downloader import HFPlaygroundDownloader
from psutil._common import bytes2human
import traceback

app = Flask(__name__)


@app.route("/api/llm/chat", methods=["POST"])
def llm_chat():
    paint_biz.dispose_basic_model()
    params = request.get_json()
    llm_params = llm_biz.LLMParams(**params)
    sse_invoker = LLM_SSE_Adapter()
    it = sse_invoker.text_conversation(llm_params)
    return Response(stream_with_context(it), content_type="text/event-stream")


@app.route("/api/llm/stopGenerate", methods=["GET"])
def stop_llm_generate():
    import llm_biz

    llm_biz.stop_generate()
    return jsonify({"code": 0, "message": "success"})


@app.route("/api/sd/generate", methods=["POST"])
def sd_generate():
    """
    {
        "device": int,
        "prompt": str,
        "model_repo_id": str,
        "mode": int,
        "image?": file,
        "mask?": file
    }
    """
    llm_biz.dispose()
    mode = request.form.get("mode", default=0, type=int)
    if mode != 0:
        if mode == 1:
            params = UpscaleImageParams()
            params.scale = request.form.get("scale", 1.5, type=float)
        elif mode == 2:
            params = ImageToImageParams()
        elif mode == 3:
            params = InpaintParams()
            params.mask_image = cache_mask_image()
        elif mode == 4:
            params = OutpaintParams()
            params.direction = request.form.get("direction", "right", type=str)

        params.image = cache_input_image()
        params.denoise = request.form.get("denoise", 0.5, type=float)
    else:
        params = TextImageParams()
    base_params = params
    base_params.device = request.form.get("device", default=0, type=int)
    base_params.prompt = request.form.get("prompt", default="", type=str)
    base_params.model_name = request.form["model_repo_id"]
    base_params.mode = mode
    base_params.width = request.form.get("width", default=512, type=int)
    base_params.negative_prompt = request.form.get(
        "negative_prompt", default="", type=str
    )
    base_params.height = request.form.get("height", default=512, type=int)
    base_params.generate_number = request.form.get(
        "generate_number", default=1, type=int
    )
    base_params.inference_steps = request.form.get(
        "inference_steps", default=12, type=int
    )
    base_params.guidance_scale = request.form.get(
        "guidance_scale", default=7.5, type=float
    )
    base_params.seed = request.form.get("seed", default=-1, type=int)
    base_params.scheduler = request.form.get("scheduler", default="None", type=str)
    base_params.lora = request.form.get("lora", default="None", type=str)
    base_params.image_preview = request.form.get("image_preview", default=0, type=int)
    base_params.safe_check = request.form.get("safe_check", default=1, type=int)
    sse_invoker = SD_SSE_Adapter(request.url_root)
    it = sse_invoker.generate(params)
    return Response(stream_with_context(it), content_type="text/event-stream")


@app.route("/api/sd/stopGenerate", methods=["GET"])
def stop_sd_generate():
    import paint_biz

    paint_biz.stop_generate()
    return jsonify({"code": 0, "message": "success"})


@app.route("/api/init", methods=["POST"])
def get_init_settings():
    import schedulers_util

    post_config: dict = request.get_json()
    for k, v in post_config.items():
        if model_config.config.__contains__(k):
            model_config.config.__setitem__(k, v)

    return jsonify(schedulers_util.schedulers)


@app.route("/api/getGraphics", methods=["POST"])
def get_graphics():
    env = request.form.get("env", default="ultra", type=str)
    return jsonify(utils.get_support_graphics(env))


@app.route("/api/applicationExit", methods=["GET"])
def applicationExit():
    from signal import SIGINT

    pid = os.getpid()
    os.kill(pid, SIGINT)


@app.route("/api/checkModelExist", methods=["POST"])
def check_model_exist():
    list = request.get_json()
    result_list = []
    for item in list:
        repo_id = item["repo_id"]
        type = item["type"]
        exist = utils.check_mmodel_exist(type, repo_id)
        result_list.append({"repo_id": repo_id, "type": type, "exist": exist})
    return jsonify({"code": 0, "message": "success", "exists": result_list})


size_cache = dict()
lock = threading.Lock()


@app.route("/api/getModelSize", methods=["POST"])
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
    if type == 4:
        total_size = utils.get_ESRGAN_size()
    else:
        total_size = HFPlaygroundDownloader().get_model_total_size(repo_id, type)
    with lock:
        size_cache.__setitem__(key, total_size)
        result_dict.__setitem__(key, bytes2human(total_size, "%(value).2f%(symbol)s"))


@app.route("/api/llm/enableRag", methods=["POST"])
def enable_rag():
    if not rag.Is_Inited:
        repo_id = request.form.get("repo_id", default="", type=str)
        device = request.form.get("device", default=0, type=int)
        rag.init(repo_id,device)
    return jsonify({"code": 0, "message": "success"})


@app.route("/api/llm/disableRag", methods=["GET"])
def disable_rag():
    if rag.Is_Inited:
        rag.dispose()
    return jsonify({"code": 0, "message": "success"})


@app.route("/api/downloadModel", methods=["POST"])
def download_model():
    list = request.get_json()
    if model_download_adpater._adapter is not None:
        model_download_adpater._adapter.stop_download()
    try:
        model_download_adpater._adapter = (
            model_download_adpater.Model_Downloader_Adapter()
        )
        iterator = model_download_adpater._adapter.download(list)
        return Response(stream_with_context(iterator), content_type="text/event-stream")
    except Exception as e:
        traceback.print_exc()

        model_download_adpater._adapter.stop_download()
        ex_str = '{{"type": "error", "err_type": "{}"}}'.format(e)
        return Response(stream_with_context([ex_str]), content_type="text/event-stream")


@app.route("/api/stopDownloadModel", methods=["GET"])
def stop_download_model():
    if model_download_adpater._adapter is not None:
        model_download_adpater._adapter.stop_download()
    return jsonify({"code": 0, "message": "success"})


@app.route("/api/llm/getRagFiles", methods=["GET"])
def get_rag_files():
    try:
        result_list = list()
        index_list = rag.get_index_list()
        if list is not None:
            for index in index_list:
                result_list.append(
                    {"filename": index.get("name"), "md5": index.get("md5")}
                )

        return jsonify({"code": 0, "message": "success", "data": result_list})
    except Exception:
        traceback.print_exc()
        return jsonify({"code": -1, "message": "failed"})


@app.route("/api/llm/uploadRagFile", methods=["POST"])
def upload_rag_file():
    try:
        path = request.form.get("path")
        code, md5 = rag.add_index_file(path)
        return jsonify({"code": code, "message": "success", "md5": md5})
    except Exception:
        traceback.print_exc()
        return jsonify({"code": -1, "message": "failed", path: path})


@app.route("/api/llm/deleteRagIndex", methods=["POST"])
def delete_rag_file():
    try:
        path = request.form.get("md5")
        rag.delete_index(path)
        return jsonify({"code": 0, "message": "success"})
    except Exception:
        traceback.print_exc()
        return jsonify({"code": -1, "message": "failed"})


def cache_input_image():
    file = request.files.get("image")
    ext = ".png"
    if file.content_type == "image/jpeg":
        ext = ".jpg"
    elif file.content_type == "image/gif":
        ext = ".gif"
    elif file.content_type == "image/bmp":
        ext = ".bmp"
    now = datetime.now()
    folder = now.strftime("%d_%m_%Y")
    base_name = now.strftime("%H%M%S")
    file_path = os.path.abspath(
        os.path.join("./static/sd_input/", folder, base_name + ext)
    )
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    file.save(file_path)
    utils.cache_file(file_path, file.__sizeof__())
    file.stream.close()
    return file_path


def cache_mask_image():
    mask_width = request.form.get("mask_width", default=512, type=int)
    mask_height = request.form.get("mask_height", default=512, type=int)
    mask_image = utils.generate_mask_image(
        request.files.get("mask_image").stream.read(), mask_width, mask_height
    )
    now = datetime.now()
    folder = now.strftime("%d_%m_%Y")
    base_name = now.strftime("%H%M%S")
    file_path = os.path.abspath(
        os.path.join("static/sd_mask/", folder, base_name + ".png")
    )
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    mask_image.save(file_path)
    utils.cache_file(file_path, os.path.getsize(file_path))
    return file_path


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AI Playground Web service")
    parser.add_argument('--port', type=int, default=59999, help='Service listen port')
    args = parser.parse_args()
    app.run(host="127.0.0.1", port=args.port)

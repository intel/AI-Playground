import os
os.environ['PATH'] = os.path.abspath('../openvino-env/Library/bin') + os.pathsep + os.environ['PATH']
import sys
current_folder = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_folder)
from apiflask import APIFlask
from flask import jsonify, request, Response, stream_with_context
from openvino_adapter import LLM_SSE_Adapter
from openvino_backend import OpenVino
from openvino_params import LLMParams

app = APIFlask(__name__)
llm_backend = OpenVino()


@app.get("/health")
def health():
    return jsonify({"code": 0, "message": "success"})


@app.post("/api/llm/chat")
def llm_chat():
    params = request.get_json()
    params.pop("print_metrics", None)
    llm_params = LLMParams(**params)
    sse_invoker = LLM_SSE_Adapter(llm_backend)
    it = sse_invoker.text_conversation(llm_params)
    return Response(stream_with_context(it), content_type="text/event-stream")


@app.post("/api/free")
def free():
    llm_backend.unload_model()
    return jsonify({"code": 0, "message": "success"})


@app.get("/api/llm/stopGenerate")
def stop_llm_generate():
    llm_backend.stop_generate = True
    return jsonify({"code": 0, "message": "success"})


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="AI Playground Web service")
    parser.add_argument("--port", type=int, default=59997, help="Service listen port")
    args = parser.parse_args()
    app.run(host="127.0.0.1", port=args.port, use_reloader=False)

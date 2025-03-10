from http.client import HTTPException
import os
os.environ['PATH'] = os.path.abspath('../openvino-env/Library/bin') + os.pathsep + os.environ['PATH']
from apiflask import APIFlask
from flask import jsonify, request, Response, stream_with_context
from openvino_backend import OpenVino
from openvino_adapter import LLM_SSE_Adapter
from openvino_params import LLMParams
from openvino_embeddings import OpenVINOEmbeddingModel
from pydantic import BaseModel

app = APIFlask(__name__)
llm_backend = OpenVino()
embedding_model = OpenVINOEmbeddingModel()

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


@app.route('/v1/embeddings', methods=['POST'])
def embeddings():
    data = request.json
    input_text = data.get('input', '')

    if not input_text:
        return jsonify({"error": "Input text is required"}), 400

    embedding_result = embedding_model.get_embedding(input_text)

    response = {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "embedding": embedding_result,
                "index": 0
            }
        ],
        "model": embedding_model.embedding_model_path,
        "usage": {
            "prompt_tokens": len(input_text.split()),
            "total_tokens": len(input_text.split())
        }
    }

    return jsonify(response)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="AI Playground Web service")
    parser.add_argument("--port", type=int, default=59997, help="Service listen port")
    args = parser.parse_args()
    app.run(host="127.0.0.1", port=args.port, use_reloader=False)

import os
os.environ['PATH'] = os.path.abspath('../llama-cpp-env/Library/bin') + os.pathsep + os.environ['PATH']

from apiflask import APIFlask
from flask import jsonify, request, Response, stream_with_context
from llama_adapter import LLM_SSE_Adapter
from llama_cpp_backend import LlamaCpp
from params import LLMParams
from llama_cpp_embeddings import LlamaCppEmbeddingModel
import utils

app = APIFlask(__name__)
llm_backend = LlamaCpp()

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

    encoding_format = data.get('encoding_format', 'float')
    input_data = data.get('input', None)
    model_name = data.get('model', "ChristianAzinn/bge-small-en-v1.5-gguf")

    if not input_data:
        return jsonify({"error": "Input text is required"}), 400

    if isinstance(input_data, str):
        input_texts = [input_data]
    elif isinstance(input_data, list):
        input_texts = input_data
    else:
        return jsonify({"error": "Input should be a string or list of strings"}), 400

    embedding_model = LlamaCppEmbeddingModel.get_instance(model_name)
    embeddings_result = embedding_model.embed_documents(input_texts)

    response = {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "embedding": utils.convert_embedding(emb, encoding_format),
                "index": idx
            } for idx, emb in enumerate(embeddings_result)
        ],
        "model": embedding_model.embedding_model_path,
        "usage": {
            "prompt_tokens": sum(len(text.split()) for text in input_texts),
            "total_tokens": sum(len(text.split()) for text in input_texts)
        }
    }

    return jsonify(response)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="AI Playground Web service")
    parser.add_argument("--port", type=int, default=59997, help="Service listen port")
    args = parser.parse_args()
    app.run(host="127.0.0.1", port=args.port, use_reloader=False)

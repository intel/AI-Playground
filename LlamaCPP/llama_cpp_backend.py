from typing import Dict, List, Callable, Iterator
from os import path
import subprocess
import requests
import json
import time
import config
import gc
from interface import LLMInterface
from params import LLMParams

class LlamaCpp(LLMInterface):
    def __init__(self):
        self._model = None  
        self.stop_generate = False
        self._last_repo_id = None
        self._model_path = None
        self._process = None
        self.api_url = "http://127.0.0.1:5005"

    def _convert_messages_to_prompt(self, messages: List[Dict[str, str]]) -> str:
        lines = []

        for msg in messages:
            content = msg.get("content", "").strip()
            if content:
                lines.append(content)
        return "\n".join(lines) + "\n"



    def load_model(self, params: LLMParams, n_gpu_layers: int = -1, context_length: int = 2048, callback: Callable[[str], None] = None):
        model_repo_id = params.model_repo_id
        if self._last_repo_id == model_repo_id:
            return 

        if callback:
            callback("start")

        self.unload_model()

        # Convert repo ID to model path
        model_base_path = config.llama_cpp_model_paths.get("ggufLLM")
        namespace, repo, *model = model_repo_id.split("/")
        model_path = path.abspath(path.join(model_base_path, "---".join([namespace, repo]), "---".join(model)))

        if not path.exists(model_path):
            raise FileNotFoundError(f"Model file not found: {model_path}")

        self._model_path = model_path

        exe_path = path.abspath("./llama-cpp-rest/llama-server.exe")
        args = [
            exe_path,
            "--model", self._model_path,
            "--port", "5005",
            "-ngl","999",

        ]

        self._process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        for i in range(30):
            try:
                r = requests.get("http://127.0.0.1:5005/health", timeout=1)
                print(f"[{i}] Status: {r.status_code}")
                if r.status_code == 200:
                    break
            except requests.RequestException as e:
                print(f"[{i}] Error: {e}")
            time.sleep(1)


        self._last_repo_id = model_repo_id

        if callback:
            callback("finish")

    def create_chat_completion(self, messages: List[Dict[str, str]], max_tokens: int = 1024) -> Iterator[str]:

        prompt = self._convert_messages_to_prompt(messages)

        response = requests.post(
            f"{self.api_url}/completion",
            json={"prompt": prompt, "n_predict": max_tokens, "stream": True, "stop": ["\nUser:", "User:", "\n###", "</s>"]},
            stream=True
        )

        response.raise_for_status()

        for line in response.iter_lines(decode_unicode=True):
            if self.stop_generate:
                self.stop_generate = False
                break
            if line:
                try:
                    json_line = json.loads(line.strip().removeprefix("data: "))
                    content = json_line.get("content", "")
                    if content:
                        yield content
                except Exception:
                    continue

    def unload_model(self):
        if self._process:
            self._process.kill()
            self._process.wait()
            self._process = None
        self._model = None
        self._last_repo_id = None
        self._model_path = None
        gc.collect()

    def get_backend_type(self):
        return "llama_cpp"

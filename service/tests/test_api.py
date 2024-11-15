import sys
import os
import unittest
import logging
import json


class TestAPI(unittest.TestCase):
    def setUp(self):
        self.service_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..")
        )
        sys.path.insert(0, self.service_dir)

        self.model_dir = os.path.abspath(os.path.join(self.service_dir, "models"))
        self.model_paths = {
            "llm": os.path.join(self.model_dir, "llm", "checkpoints"),
            "embedding": os.path.join(self.model_dir, "llm", "embedding"),
            "inpaint": os.path.join(self.model_dir, "stable_diffusion", "inpaint"),
            "lora": os.path.join(self.model_dir, "stable_diffusion", "lora"),
            "stableDiffusion": os.path.join(
                self.model_dir, "stable_diffusion", "checkpoints"
            ),
            "vae": os.path.join(self.model_dir, "stable_diffusion", "vae"),
        }

        from web_api import app

        self.app = app.test_client()

        self.devices = {}
        self.llm_model_id = "microsoft/Phi-3-mini-4k-instruct"

    def test_get_graphics(self):
        response = self.app.post("/api/getGraphics")
        supported_graphics = response.get_json()
        for graphics in supported_graphics:
            logging.info(f"Device #{graphics['index']}: {graphics['name']}")
            self.devices[graphics["index"]] = graphics["name"]
        self.assertGreater(len(supported_graphics), 0)
        self.assertEqual(response.status_code, 200)

    def test_init(self):
        response = self.app.post("/api/init", json=self.model_paths)
        schedulers = response.get_json()
        self.assertEqual(
            set(schedulers),
            {
                "DPM++ 2M",
                "DPM++ 2M Karras",
                "DPM++ SDE",
                "DPM++ SDE Karras",
                "DPM2",
                "DPM2 Karras",
                "DPM2 a",
                "DPM2 a Karras",
                "Euler",
                "Euler a",
                "Heun",
                "LMS",
                "LMS Karras",
                "DEIS",
                "UniPC",
                "DDIM",
                "DDPM",
                "EDM Euler",
                "PNDM",
                "LCM",
            },
        )
        self.assertEqual(response.status_code, 200)

    def get_llm_chat_payload(self, prompt):
        return {
            "device": 0,
            "enable_rag": False,
            "model_repo_id": self.llm_model_id,
            "prompt": [{"question": prompt, "answer": ""}],
        }

    def decode_stream(self, stream_data):
        event_data = []
        for line in stream_data.split(b"\x00"):
            if line.startswith(b"data:"):
                data_json = line.split(b"data:")[1].strip()
                try:
                    data = json.loads(data_json)
                    event_data.append(data)
                except json.JSONDecodeError:
                    self.fail(f"Failed to decode JSON: {data_json}")
        return event_data

    def llm_warmup(self):
        logging.info("Warming up LLM...")
        response = self.app.post("/api/llm/chat", json=self.get_llm_chat_payload("hi"))
        self.assertEqual(response.status_code, 200)

        event_data = self.decode_stream(response.data)
        self.assertGreater(len(event_data), 0)

    def test_llm_chat(self):
        self.llm_warmup()

        logging.info("Testing LLM chat...")
        response = self.app.post(
            "/api/llm/chat",
            json=self.get_llm_chat_payload(
                "Please explain in detail: why is sky blue?"
            ),
        )
        self.assertEqual(response.status_code, 200)

        event_data = self.decode_stream(response.data)
        self.assertGreater(len(event_data), 0)


if __name__ == "__main__":
    unittest.main()

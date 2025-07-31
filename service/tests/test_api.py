import sys
import os
import unittest
import logging


class TestAPI(unittest.TestCase):
    def setUp(self):
        self.service_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..")
        )
        sys.path.insert(0, self.service_dir)

        self.model_dir = os.path.abspath(os.path.join(self.service_dir, "models"))
        self.model_paths = {
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



if __name__ == "__main__":
    unittest.main()

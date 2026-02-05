# Adapted from https://github.com/BetaDoggo/ComfyUI-YetAnotherSafetyChecker/
# Copyright (c) 2024 BetaDoggo
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Modified to use local model paths from ComfyUI's
# folder_paths instead of HuggingFace Hub for offline capability.

import os
from transformers import pipeline
from torchvision import transforms
import torch
import folder_paths


class SafetyChecker:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "threshold": (
                    "FLOAT",
                    {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    FUNCTION = "process_images"

    CATEGORY = "image/processing"

    def process_images(self, image, threshold):
        device = "cpu"
        predict = pipeline(
            "image-classification",
            model=os.path.join(
                folder_paths.get_folder_paths("nsfw_detector")[0],
                "vit-base-nsfw-detector",
            ),
            device=device,
        )  # init pipeline
        result = predict(
            transforms.ToPILImage()(image[0].cpu().permute(2, 0, 1))
        )  # Convert to expected format
        score = next(item["score"] for item in result if item["label"] == "nsfw")
        output = image
        if float(score) > threshold:
            output = torch.zeros(
                1, 512, 512, dtype=torch.float32
            )  # create black image tensor
        return (output, str(score))


NODE_CLASS_MAPPINGS = {"SafetyChecker": SafetyChecker}

NODE_DISPLAY_NAME_MAPPINGS = {"SafetyChecker": "Safety Checker"}

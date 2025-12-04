# Shared configuration settings for all backends

# Model paths for different backends
# NOTE: These are defaults/fallbacks only. Actual paths are passed via API calls.
# service_model_paths removed - was part of old ipexllm inference backend

# LlamaCPP model paths (defaults only - fallback if not provided via API)
llama_cpp_model_paths = {
    "ggufLLM": "../models/LLM/ggufLLM",
    "embedding": "../models/LLM/embedding/llamaCPP",
}
# OpenVINO model paths (defaults only - fallback if not provided via API)
openvino_model_paths = {
    "openvinoLLM": "../models/LLM/openvino",
    "embedding": "../models/LLM/embedding/openVINO",
}

# ComfyUI related paths
comfy_ui_root_path = "../ComfyUI"
comfyui_python_exe = "../comfyui-backend-env/python.exe"
comfyui_python_env = "../comfyui-backend-env"

# ComfyUI model paths (defaults only)
comfy_ui_model_paths = {
    "checkpoints": "../models/ComfyUI/checkpoints",
    "unet": "../models/ComfyUI/unet",
    "clip": "../models/ComfyUI/clip",
    "vae": "../models/ComfyUI/vae",
    "diffusion_models": "../models/ComfyUI/diffusion_models",
    "faceswap": "../models/ComfyUI/insightface",
    "facerestore": "../models/ComfyUI/facerestore_models",
    "nsfwdetector": "../models/ComfyUI/nsfw_detector",
    "controlNet": "../models/ComfyUI/controlnet",
    "upscale": "../models/ComfyUI/upscale_models",
    "lora": "../models/ComfyUI/loras",
    "loras": "../models/ComfyUI/loras",
}

# Git configuration
git = {
    "rootDirPath": "../portable-git",
    "exePath": "../portable-git/cmd/git.exe",
}

# Default device
device = "xpu"

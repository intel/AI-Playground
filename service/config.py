# Shared configuration settings for all backends

# Model paths for different backends
service_model_paths = {
    "llm": "./models/llm/checkpoints",
    "embedding": "./models/llm/embedding/ipexLLM",
}

# LlamaCPP model paths
llama_cpp_model_paths = {
    "ggufLLM": "../service/models/llm/ggufLLM",
    "embedding": "../service/models/llm/embedding/llamaCPP",
}
# OpenVINO model paths
openvino_model_paths = {
    "openvinoLLM": "../service/models/llm/openvino",
    "embedding": "../service/models/llm/embedding/openVINO",
}

# ComfyUI related paths
comfy_ui_root_path = "../ComfyUI"
comfyui_python_exe = "../comfyui-backend-env/python.exe"
comfyui_python_env = "../comfyui-backend-env"

comfy_ui_model_paths = {
    "checkpoints": f"{comfy_ui_root_path}/models/checkpoints",
    "unet": f"{comfy_ui_root_path}/models/unet",
    "clip": f"{comfy_ui_root_path}/models/clip",
    "vae": f"{comfy_ui_root_path}/models/vae",
    "faceswap": f"{comfy_ui_root_path}/models/insightface",
    "facerestore": f"{comfy_ui_root_path}/models/facerestore_models",
    "nsfwdetector": f"{comfy_ui_root_path}/models/nsfw_detector",
    "controlNet": f"{comfy_ui_root_path}/models/controlnet",
    "upscale": f"{comfy_ui_root_path}/models/upscale_models",
    "defaultCheckpoint": "./models/stable_diffusion/checkpoints",
    "defaultLora": "./models/stable_diffusion/lora",
}

# Git configuration
git = {
    "rootDirPath": "../portable-git",
    "exePath": "../portable-git/cmd/git.exe",
}

# Default device
device = "xpu"

# Model type conversion mapping - deprecated, kept for backward compatibility
# All model types are now strings, this function is a no-op identity function
def convert_model_type(type):
    """Convert model type - now a no-op since types are already strings"""
    if isinstance(type, str):
        return type
    # Legacy support for numeric types (should not be used in new code)
    type_map = {
        0: "llm",
        5: "embedding",
        8: "ggufLLM",
        9: "openvinoLLM",
        100: "unet",
        101: "clip",
        102: "vae",
        103: "defaultCheckpoint",
        104: "defaultLora",
        105: "controlNet",
        106: "faceswap",
        107: "facerestore",
        108: "nsfwdetector",
        109: "checkpoints",
        110: "upscale",
    }
    if type in type_map:
        return type_map[type]
    raise Exception(f"unknown model type value {type}")

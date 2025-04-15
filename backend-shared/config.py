# Shared configuration settings for all backends

# Model paths for different backends
service_model_paths = {
    "llm": "./models/llm/checkpoints",
    "embedding": "./models/llm/embedding/ipexLLM",
    "stableDiffusion": "./models/stable_diffusion/checkpoints",
    "lora": "./models/stable_diffusion/lora",
    "vae": "./models/stable_diffusion/vae",
    "inpaint": "./models/stable_diffusion/inpaint",
    "ESRGAN": "./models/stable_diffusion/ESRGAN",
    "preview": "./models/stable_diffusion/preview",
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

# Model type conversion mapping
def convert_model_type(type: int):
    if type == 0:
        return "llm"
    elif type == 1:
        return "stableDiffusion"
    elif type == 2:
        return "lora"
    elif type == 3:
        return "vae"
    elif type == 4:
        return "ESRGAN"
    elif type == 5:
        return "embedding"
    elif type == 6:
        return "inpaint"
    elif type == 7:
        return "preview"
    elif type == 8:
        return "ggufLLM"
    elif type == 9:
        return "openvinoLLM"
    elif type == 100:
        return "unet"
    elif type == 101:
        return "clip"
    elif type == 102:
        return "vae"
    elif type == 103:
        return "defaultCheckpoint"
    elif type == 104:
        return "defaultLora"
    elif type == 105:
        return "controlNet"
    elif type == 106:
        return "faceswap"
    elif type == 107:
        return "facerestore"
    elif type == 108:
        return "nsfwdetector"
    elif type == 109:
        return "checkpoints"
    else:
        raise Exception(f"unknown model type value {type}")

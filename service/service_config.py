# CONFIG_PATH = "./service_config.json"
service_model_paths = {
    "llm": "./models/llm/checkpoints",
    "embedding": "./models/llm/embedding",
    "stableDiffusion": "./models/stable_diffusion/checkpoints",
    "lora": "./models/stable_diffusion/lora",
    "vae": "./models/stable_diffusion/vae",
    "inpaint": "./models/stable_diffusion/inpaint",
    "ESRGAN": "./models/stable_diffusion/ESRGAN",
    "preview": "./models/stable_diffusion/preview",
}


comfy_ui_root_path = "../ComfyUI"
git = {
    "rootDirPath": "../portable-git",
    "exePath": "../portable-git/cmd/git.exe",
}

comfyui_python_exe = "../comfyui-backend-env/python.exe"
comfyui_python_env = "../comfyui-backend-env"

comfy_ui_model_paths = {
    "unet": f"{comfy_ui_root_path}/models/unet",
    "clip": f"{comfy_ui_root_path}/models/clip",
    "vae": f"{comfy_ui_root_path}/models/vae",
    "faceswap": f"{comfy_ui_root_path}/models/insightface",
    "facerestore": f"{comfy_ui_root_path}/models/facerestore_models",
    "controlNet": f"{comfy_ui_root_path}/models/controlnet",
    "defaultCheckpoint": "./models/stable_diffusion/checkpoints",
    "defaultLora": "./models/stable_diffusion/lora",
}

llama_cpp_model_paths = {
    "ggufLLM": "./models/llm/ggufLLM",
}

device = "xpu"

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
    "rootDirPath": "../git",
    "exePath": "../git/cmd/git.exe",
}

comfy_ui_model_paths = {
    "unet": f"{comfy_ui_root_path}/models/unet",
    "clip": f"{comfy_ui_root_path}/models/clip",
    "vae": f"{comfy_ui_root_path}/models/vae",
    "controlNet": f"{comfy_ui_root_path}/models/controlnet",
    "defaultCheckpoint": "./models/stable_diffusion/checkpoints",
    "defaultLora": "./models/stable_diffusion/lora",
}

device = "xpu"
env_type = "arc"

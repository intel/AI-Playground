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


device = "cuda"
comfyUIRootPath = "../ComfyUI"
seven_z_exe_path = "../7zr.exe"
git = {
    "rootDirPath": "../git",
    "exePath": "../git/bin/git.exe",
}

comfyUIModels = {
    "unet": f"{comfyUIRootPath}/models/unet",
    "clip": f"{comfyUIRootPath}/models/clip",
    "vae": f"{comfyUIRootPath}/models/vae",
}



device = "xpu"
env_type = "arc"

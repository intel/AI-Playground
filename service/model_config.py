
# CONFIG_PATH = "./model_config.json"

config = {
    "llm": "./models/llm/checkpoints",
    "embedding": "./models/llm/embedding",
    "stableDiffusion": "./models/stable_diffusion/checkpoints",
    "lora": "./models/stable_diffusion/lora",
    "vae": "./models/stable_diffusion/vae",
    "inpaint": "./models/stable_diffusion/inpaint",
    "ESRGAN": "./models/stable_diffusion/ESRGAN",
    "preview": "./models/stable_diffusion/preview",
}

comfyUIConfig = {
    "unet": "../ComfyUI/models/unet",
    "clip": "../ComfyUI/models/clip",
    "vae": "../ComfyUI/models/vae",
}

device = "xpu"
env_type = "arc"
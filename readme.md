<a href="https://scan.coverity.com/projects/ai-playground">
  <img alt="Coverity Scan Build Status"
       src="https://scan.coverity.com/projects/30694/badge.svg"/>
</a>

# AI PLAYGROUND 3.0.2 beta
<img width="2025" height="593" alt="image" src="https://github.com/user-attachments/assets/76c47f53-cd1b-419c-9ffb-43ba2369c84b" />


Welcome to AI Playground open source project and AI PC generative AI application suite. This application provides a full suite of generative AI features for chat, code assistance, document search, image analysis, image and video generation. All features run offline and are powered by your PC’s Intel® Core™ Ultra with built-in Intel Arc GPU or Intel Arc™ dGPU Series A or B with 8GB+ of vRAM.

AI Playground is intended to act as an offline alternative to cloud tools such Gemini ChatGPT and Grok.  AI Playground leverages libraries from GitHub and Huggingface including:
- Image Diffusion (PyTorch 2.10): Stable Diffusion 1.5, SDXL, Flux.1-Schnell, Flux.1 Kontext[dev], Z-Image, Wan2.1 VACE, LTX-Video
- LLM: GGUF (Llama.cpp Vulkan) - Qwen3 VL, GPT-OSS 20B, DeepSeek R1 Distilled, Phi3, Mistral 7B, Llama 3.2: OpenVINO - TinyLlama, Mistral 7B, Phi3 mini, Phi3.5 mini, DeepSeek R1 Distill (1.5B, 7B)
<img width="3221" height="1849" alt="image" src="https://github.com/user-attachments/assets/da8f2870-3d48-49ac-bf82-8feb44f460ee" />

As a local alternative to cloud AI service, AI Playground is intended to give consumers and AI curious prosumers easy and intuitive access to a wide variety of generative AI features using their Intel powered AI PC. This means you can be offline, without loading sensitive or personal data to 3rd party sites, for free, in a single app without having to know how to install and manage multiple AI backend frameworks.   Key features:
- Latest and greatest chat models: Support for Qwen 3 VL, Mistral 7B, DeepSeek R1 or GPT-OSS, AI playground makes a variety of chat models available to users
- Vision, Reasoning and RAG: Chat features support Vision, Reasoning and RAG to analyze and get deep answers on both visual and text content
Analyze images with Qwen3 VL Model	Vibe Coding with GPT-OSS 20B Reasoning	Document RAG with Mistral 7B Instruct
- Image Generation: From Stable Diffusion 1.5, SDXL, Flux.1 and Z-image models AI Playground is making a breadth of image generation from quick easy low-res draft generation to high quality image generation
- Image Editing: Subscription free and private control for upscaling, inpainting, outpainting, 2D to 3D mesh or editing images in a variety of ways.  Good for editing personal photos to taking sketches and generated images to the next level with greater control. 

## README.md
- English (readme.md)

## Min Specs
AI Playground alpha and beta installers are currently available downloadable executables, or available as a source code from our Github repository.  To run AI Playground you must have a PC that meets the following specifications

*	Windows OS
*	Intel Core Ultra Series 3, Series 2H, Series 2V, or Series 1 H processor OR Intel Arc GPU Series A or Series B (discrete) with 8GB of vRAM

## Installation - Packaged Installer: 
This is a single packaged installer for all supported hardware mentioned above. This installer simplifies the process for end users to install AI Playground on their PCs. Please note that while this makes the installation process easier, this is open-source beta software, and there may be component and version conflicts. Refer to the Troubleshooting section for known issues.

### Download the installer
:new: **AI Playground 3.0.2 beta (all SKUs)** - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v3.0.2-beta) | [Download](https://github.com/intel/AI-Playground/releases/download/v3.0.2-beta/AI-Playground-installer.exe) :new:

### Installation Process for v3.0
1. The installer only installs the Electron frontend, so it completes very quickly.
2. On the first run, AI Playground Setup window appears where you install needed backend components for AI Playground to function properly. This process requires a strong and open network and may **take several minutes**.
3. Download the Users Guide for application information: [AI Playground Users Guide](https://github.com/intel/AI-Playground/blob/main/AI%20Playground%20Users%20Guide.pdf)

### Troubleshooting Installation
The following are known situations where your installation may be blocked or interrupted.  Review the following to remedy installations issues.  If installation issues persist, generate a copy of the log by typing CTRL+SHIFT+I, select the console tab and copy the last few entries of the log written where the installer failed.  Provide these details to us via the issues tab here, or via the Intel Insiders Discord, or Graphics forum on Intel's support site.

1. **Llama.cpp embedding issues**: At the time of this release, Llama.cpp embeddings may have issues with:
  * Recent drivers, and may require DDU to clean driver cache.
  * Anti-Virus software - features needed to read and write embedding cache may not be properly installed:  Disable anti-virus, restart 
2. **Restart**: Time-out issues have been sighted, which show as a failed install but resolve when restarting AI Playground
3. **Verify Intel Arc GPU**: Ensure your system has an Intel Arc GPU with the lastest driver. Go to your Windows Start Menu, type "Device Manager," and under Display Adapters, check the name of your GPU device. It should describe an Intel Arc GPU. If so, then you you have a GPU that means our minimum specifications.  If it says "Intel(R) Graphics," your system does not have a built-in Intel Arc GPU and does not meet the minimum specifications. If your GPU is an discrete GPU such as Intel Arc A or B series GPU, then you can troubleshoot a troubled installation by disabling the iGPU in Device Manager
4. **Interrupted Installation**: The online installation for backend components can be interrupted or blocked by an IT network, firewall, or sleep settings. Ensure you are on an open network, with the firewall off, and set sleep settings to stay awake when powered on.
5. **Missing Libraries**: Some Windows systems may be missing needed libraries. This can be fixed by installing the 64-bit VC++ redistribution from Microsoft [here](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170). It is recommended this be done after updating the Graphics drivers. Then install AI Playground.
6. **Python Conflict**: Some PCs with an existing installation of Python can cause a conflict with AI Playground installation, where the wrong or conflicting packages are installed due to the incorrect version or location of Python on the system.  This is usually remedied by uninstalling Python environment, restarting and reinstalling AI Playground
7.  **Temp Files**: Should the installation be interrupted because of any of the above issues it is possible that temporary installation files have been left behind and trying to install with these files in place can block the installation. Remove these files or do a clean install of AI Playground to remedy

## Project Development
### Checkout Source Code

To get started, clone the repository and navigate to the project directory:

```cmd
git clone -b dev https://github.com/intel/AI-Playground.git
cd AI-Playground
```

### Install Node.js Dependencies

1. Install the Node.js development environment from [Node.js](https://nodejs.org/en/download).

2. Navigate to the `WebUI` directory and install all Node.js dependencies:

```cmd
cd WebUI
npm install
```

### Fetch External Resources

1. In the `WebUI` directory, execute the `fetch-external-resources` script to download required external resources:

This will download `uv` (Python package manager) and other required tools to the `build/resources/` directory.

### Launch the application

To start the application in development mode, run:

```
npm run dev
```

### (Optional) Build the installer

To build the installer, run:

```
npm run build
```

The installer executable will be located in the `build/electron` folder.

## Model Support
AI Playground does not ship with any generative AI models but does make models available for all features either directly from the interface or indirectly by the users downloading models from HuggingFace.co or CivitAI.com and placing them in the appropriate model folder. 

Models currently linked from the application 

### AI Model & License Registry

| Model Path / Name | Model Card (HF) | License Link |
| :--- | :--- | :--- |
| AdamCodd/vit-base-nsfw-detector | [Model Card](https://huggingface.co/AdamCodd/vit-base-nsfw-detector) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Aitrepreneur/insightface/inswapper_128.onnx | [Model Card](https://huggingface.co/Aitrepreneur/insightface) | [Non-Commercial](https://huggingface.co/Aitrepreneur/insightface#license) |
| alimama-creative/FLUX.1-Turbo-Alpha | [Model Card](https://huggingface.co/alimama-creative/FLUX.1-Turbo-Alpha) | [FLUX.1-dev License](https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md) |
| BGE Small EN v1.5 (GGUF) | [Model Card](https://huggingface.co/BAAI/bge-small-en-v1.5) | [MIT License](https://opensource.org/licenses/MIT) |
| black-forest-labs/FLUX.2-klein-4b-fp8/flux-2-klein-4b-fp8.safetensors | [Model Card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| city96/t5-v1_1-xxl-encoder-gguf/t5-v1_1-xxl-encoder-Q3_K_M.gguf | [Model Card](https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| city96/t5-v1_1-xxl-encoder-gguf/t5-v1_1-xxl-encoder-Q4_K_M.gguf | [Model Card](https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| city96/umt5-xxl-encoder-gguf/umt5-xxl-encoder-Q4_K_M.gguf | [Model Card](https://huggingface.co/city96/umt5-xxl-encoder-gguf) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| comfyanonymous/flux_text_encoders/clip_l.safetensors | [Model Card](https://huggingface.co/comfyanonymous/flux_text_encoders) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| comfyanonymous/flux_text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors | [Model Card](https://huggingface.co/comfyanonymous/flux_text_encoders) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Comfy-Org/flux1-kontext-dev/flux1-dev-kontext_fp8_scaled.safetensors | [Model Card](https://huggingface.co/Comfy-Org/flux1-kontext-dev) | [FLUX.1-dev License](https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md) |
| Comfy-Org/Lumina_Image_2.0_Repackaged/ae.safetensors | [Model Card](https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Comfy-Org/Real-ESRGAN_repackaged/RealESRGAN_x4plus.safetensors | [Model Card](https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged) | [BSD-3-Clause](https://opensource.org/licenses/BSD-3-Clause) |
| Comfy-Org/Wan_2.1_ComfyUI_repackaged/wan_2.1_vae.safetensors | [Model Card](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged) | [Wan 2.1 License](https://huggingface.co/Wan-AI/Wan2.1-T2V-14B/blob/main/LICENSE) |
| Comfy-Org/z_image_turbo/ae.safetensors | [Model Card](https://huggingface.co/Comfy-Org/z_image_turbo) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Comfy-Org/z_image_turbo/qwen_3_4b.safetensors | [Model Card](https://huggingface.co/Comfy-Org/z_image_turbo) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Comfy-Org/z_image_turbo/z_image_turbo_bf16.safetensors | [Model Card](https://huggingface.co/Comfy-Org/z_image_turbo) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| DeepSeek-R1-Distill-Qwen 1.5B | [Model Card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B) | [MIT License](https://opensource.org/licenses/MIT) |
| DeepSeek-R1-Distill-Qwen 7B | [Model Card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B) | [MIT License](https://opensource.org/licenses/MIT) |
| Gemma 3 4B IT (Unsloth) | [Model Card](https://huggingface.co/unsloth/gemma-3-4b-it) | [Gemma License](https://ai.google.dev/gemma/terms) |
| gmk123/GFPGAN/GFPGANv1.4.pth | [Model Card](https://huggingface.co/gmk123/GFPGAN) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| GPT-OSS 20B (Unsloth) | [Model Card](https://huggingface.co/unsloth/gpt-oss-20b) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| InternVL2 4B (OV) | [Model Card](https://huggingface.co/OpenGVLab/InternVL2-4B) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| latent-consistency/lcm-lora-sdv1-5/pytorch_lora_weights.safetensors | [Model Card](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5) | [OpenRAIL++](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| latent-consistency/lcm-lora-sdxl/pytorch_lora_weights.safetensors | [Model Card](https://huggingface.co/latent-consistency/lcm-lora-sdxl) | [OpenRAIL++](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Lightricks/LTX-Video/ltxv-2b-0.9.6-distilled-04-25.safetensors | [Model Card](https://huggingface.co/Lightricks/LTX-Video) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Llama 3.2 3B Instruct | [Model Card](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct) | [Llama 3.2 License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE) |
| lllyasviel/fooocus_inpaint/fooocus_inpaint_head.pth | [Model Card](https://huggingface.co/lllyasviel/fooocus_inpaint) | [OpenRAIL](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| lllyasviel/fooocus_inpaint/inpaint_v26.fooocus.patch | [Model Card](https://huggingface.co/lllyasviel/fooocus_inpaint) | [OpenRAIL](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Lykon/DreamShaper/DreamShaper_8_pruned.safetensors | [Model Card](https://huggingface.co/Lykon/DreamShaper) | [OpenRAIL-M](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Lykon/dreamshaper-8-inpainting/text_encoder/model.safetensors | [Model Card](https://huggingface.co/Lykon/dreamshaper-8-inpainting) | [OpenRAIL-M](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Lykon/dreamshaper-8-inpainting/unet/model.safetensors | [Model Card](https://huggingface.co/Lykon/dreamshaper-8-inpainting) | [OpenRAIL-M](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Lykon/dreamshaper-8-inpainting/vae/model.safetensors | [Model Card](https://huggingface.co/Lykon/dreamshaper-8-inpainting) | [OpenRAIL-M](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| Meta-Llama 3.1 8B Instruct | [Model Card](https://huggingface.co/meta-llama/Meta-Llama-3.1-8B-Instruct) | [Llama 3.1 License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE) |
| Mistral 7B Instruct v0.2 (OV) | [Model Card](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.2) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Mistral 7B Instruct v0.3 | [Model Card](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Mistral 7B Instruct v0.3 (OV) | [Model Card](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Nomic Embed Text v1.5 (GGUF) | [Model Card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Phi-3 Mini 4k Instruct (OV) | [Model Card](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct) | [MIT License](https://opensource.org/licenses/MIT) |
| Phi-3.5 Mini Instruct (OV) | [Model Card](https://huggingface.co/microsoft/Phi-3.5-mini-instruct) | [MIT License](https://opensource.org/licenses/MIT) |
| QuantStack/Wan2.1_14B_VACE-GGUF/Wan2.1_14B_VACE-Q8_0.gguf | [Model Card](https://huggingface.co/QuantStack/Wan2.1_14B_VACE-GGUF) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Qwen2-VL 7B Instruct (OV) | [Model Card](https://huggingface.co/Qwen/Qwen2-VL-7B-Instruct) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Qwen3 4B (OV) | [Model Card](https://huggingface.co/Qwen/Qwen2.5-4B) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Qwen3 4B (Unsloth) | [Model Card](https://huggingface.co/unsloth/Qwen2.5-4B) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Qwen3 4B Instruct 2507 (Unsloth) | [Model Card](https://huggingface.co/unsloth/Qwen2.5-4B-Instruct) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Qwen3-VL 4B Instruct (Unsloth) | [Model Card](https://huggingface.co/unsloth/Qwen2-VL-7B-Instruct) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| RunDiffusion/Juggernaut-XL-v9/RunDiffusionPhoto_v2.safetensors | [Model Card](https://huggingface.co/RunDiffusion/Juggernaut-XL-v9) | [OpenRAIL-M](https://huggingface.co/spaces/CompVis/stable-diffusion-license) |
| SmolLM2 1.7B Instruct | [Model Card](https://huggingface.co/HuggingFaceTB/smollm2-1.7b-instruct) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| stabilityai/control-lora/rank128-canny-rank128.safetensors | [Model Card](https://huggingface.co/stabilityai/control-lora) | [SAI Community](https://huggingface.co/stabilityai/control-lora#license) |
| tencent/Hunyuan3D-2.1/hunyuan3d-dit-v2-1/model.fp16.ckpt | [Model Card](https://huggingface.co/tencent/Hunyuan3D-2.1) | [Hunyuan3D License](https://huggingface.co/tencent/Hunyuan3D-2.1/blob/main/LICENSE.txt) |
| tencent/Hunyuan3D-2/hunyuan3d-dit-v2-0/model.fp16.safetensors | [Model Card](https://huggingface.co/tencent/Hunyuan3D-2) | [Hunyuan3D License](https://huggingface.co/tencent/Hunyuan3D-2/blob/main/LICENSE.txt) |
| TinyLlama 1.1B Chat (OV) | [Model Card](https://huggingface.co/TinyLlama/TinyLlama-1.1B-Chat-v1.0) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Whisper (OV) | [Model Card](https://huggingface.co/openai/whisper-large-v3) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |



Be sure to check license terms for any model used in AI Playground especially taking note of any restrictions.

### Use Alternative Models
Check the [User Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf) for details or [watch this video](https://www.youtube.com/watch?v=1FXrk9Xcx2g) on how to add alternative Stable Diffusion models to AI Playground


## Notices and Disclaimers: 
For information on AI Playground terms, license and disclaimers, visit the project and files on GitHub repo:</br >
[License](https://github.com/intel/ai-playground/blob/main/LICENSE) | [Notices & Disclaimers](https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md)

The software may include third party components with separate legal notices or governed by other agreements, as may be described in the Third Party Notices file accompanying the software.

## Credit
License details for borrowed code and components can be found in our [3rdpartynoticeslicense](3rdpartynoticeslicenses.txt) file.  
Additionally, these entities and their work stand out as are fundamental to AI Playground.
*	PyTorch - https://pytorch.org/ 
*	Stable Diffusion - https://github.com/Stability-AI/stablediffusion
*	ComfyUI -  https://github.com/comfyanonymous/ComfyUI
*	OpenVINO - https://openvinotoolkit.github.io/openvino.genai/ 
*	Llama.cpp - https://github.com/ggml-org/llama.cpp 
*	Vue.js - https://vuejs.org/ 
*	Plus countless other open-source projects and contributors that make this work possible!


<img width="316" height="46" alt="image" src="https://github.com/user-attachments/assets/7dacde60-8230-42c3-8d5a-f0a262320a93" /># AI Playground

<a href="https://scan.coverity.com/projects/ai-playground">
  <img alt="Coverity Scan Build Status"
       src="https://scan.coverity.com/projects/30694/badge.svg"/>
</a>

![image](https://github.com/user-attachments/assets/ee1efc30-4dd1-4934-9233-53fba00c71bd)


This example is based on the xpu implementation of Intel® Arc™ GPU.

Welcome to AI Playground open source project and AI PC starter app for doing AI image creation, image stylizing, and chatbot on a PC powered by an Intel® Arc™ GPU. AI Playground leverages libraries from GitHub and Huggingface which may not be available in all countries world-wide.  AI Playground supports many Gen AI libraries and models including:
- Image Diffusion (PyTorch 2.8): Stable Diffusion 1.5, SDXL, Flux.1-Schnell, Flux.1 Kontext[dev], Wan2.1 VACE, LTX-Video
- LLM: GGUF (Llama.cpp Vulknan) - GPT-OSS 20B, DeepSeek R1 Distilled, Phi3, Mistral 7B, Llama 3.2: OpenVINO - TinyLlama, Mistral 7B, Phi3 mini, Phi3.5 mini, DeepSeek R1 Distill (1.5B, 7B)

## README.md
- English (readme.md)

## Min Specs
AI Playground alpha and beta installers are currently available downloadable executables, or available as a source code from our Github repository.  To run AI Playground you must have a PC that meets the following specifications

*	Windows OS
*	Intel Core Ultra-H Processor, Intel Core Ultra-V processor OR Intel Arc GPU Series A or Series B (discrete) with 8GB of vRAM

## Installation - Packaged Installer: 
This is a single packaged installer for all supported hardware mentioned above. This installer simplifies the process for end users to install AI Playground on their PCs. Please note that while this makes the installation process easier, this is open-source beta software, and there may be component and version conflicts. Refer to the Troubleshooting section for known issues.

### Download the installer
:new: **AI Playground 2.6.1 Beta (all SKUs)** - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v2.6.1-beta) | [Download](https://github.com/intel/AI-Playground/releases/download/v2.6.1-beta/AI_Playground.exe) :new:

### Installation Process for v2.0
1. The installer only installs the Electron frontend, so it completes very quickly.
2. On the first run, you need to install additional backend components for AI Playground to function properly. This process requires a strong and open network and may **take several minutes**.
3. Download the Users Guide for application information: [AI Playground Users Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf)

### Troubleshooting Installation
The following are known situations where your installation may be blocked or interrupted.  Review the following to remedy installations issues.  If installation issues persist, generate a copy of the log by typing CTRL+SHIFT+I, select the console tab and copy the last few entries of the log written where the installer failed.  Provide these details to us via the issues tab here, or via the Intel Insiders Discord, or Graphics forum on Intel's support site.
1. **Restart**: Time-out issues have been sighted, which show as a failed install but resolve when restarting AI Playground
2. **Verify Intel Arc GPU**: Ensure your system has an Intel Arc GPU with the lastest driver. Go to your Windows Start Menu, type "Device Manager," and under Display Adapters, check the name of your GPU device. It should describe an Intel Arc GPU. If so, then you you have a GPU that means our minimum specifications.  If it says "Intel(R) Graphics," your system does not have a built-in Intel Arc GPU and does not meet the minimum specifications. If your GPU is an discrete GPU such as Intel Arc A or B series GPU, then you can troubleshoot a troubled installation by disabling the iGPU in Device Manager
3. **Interrupted Installation**: The online installation for backend components can be interrupted or blocked by an IT network, firewall, or sleep settings. Ensure you are on an open network, with the firewall off, and set sleep settings to stay awake when powered on.
4. **Missing Libraries**: Some Windows systems may be missing needed libraries. This can be fixed by installing the 64-bit VC++ redistribution from Microsoft [here](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170). It is recommended this be done after updating the Graphics drivers. Then install AI Playground.
5. **Python Conflict**: Some PCs with an existing installation of Python can cause a conflict with AI Playground installation, where the wrong or conflicting packages are installed due to the incorrect version or location of Python on the system.  This is usually remedied by uninstalling Python environment, restarting and reinstalling AI Playground
6.  **Temp Files**: Should the installation be interrupted because of any of the above issues it is possible that temporary installation files have been left behind and trying to install with these files in place can block the installation. Remove these files or do a clean install of AI Playground to remedy

## Project Development

### Prerequisites

Before starting, ensure you have the following installed:

- **Node.js** - Download from [Node.js](https://nodejs.org/en/download) (v18 or later recommended)
- **Python 3.12** - The project specifically requires Python 3.12.x
- **uv** - Python package manager for dependency management

### Checkout Source Code

Clone the repository and navigate to the project directory:

```cmd
git clone -b dev https://github.com/intel/AI-Playground.git
cd AI-Playground
```

### Install Python Dependencies

Install the backend service dependencies:

```cmd
cd service
python -m uv sync
cd ..
```

Install ComfyUI dependencies (optional, for advanced image generation features):

```cmd
cd comfyui-deps
python -m uv sync
cd ..
```

Note: If you encounter hash mismatch errors with PyTorch packages, this is a known issue with the upstream PyTorch XPU repository and doesn't prevent the basic app from running.

### Install Node.js Dependencies

Navigate to the `WebUI` directory and install all Node.js dependencies:

```cmd
cd WebUI
npm install
```

### Fetch Build Resources

Download required build resources (7-Zip utility for extracting portable Git):

```cmd
npm run fetch-build-resources
```

### Launch the Application

Start the application in development mode:

```cmd
npm run dev
```

The application will start an Electron window and be accessible at `http://127.0.0.1:25413` (or the next available port if 25413 is in use).

The dev server includes:
- Hot module reloading for Vue.js components
- Automatic backend service startup
- API proxy from port 25413 to backend port 9999

### (Optional) Build the Installer

To prepare resources and build the production installer:

```cmd
npm run prepare-build
npm run build
```

The installer executable will be located in the `release` folder.

## Model Support
AI Playground does not ship with any generative AI models but does make models available for all features either directly from the interface or indirectly by the users downloading models from HuggingFace.co or CivitAI.com and placing them in the appropriate model folder. 

Models currently linked from the application 
| Model                                      | License                                                                                                                                                                      | Background Information/Model Card                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| IMAGE GEN                        |                                            |                              |
| Dreamshaper 8 Model (SD1.5)                       | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/Lykon/dreamshaper-8)                               |
| Dreamshaper 8 Inpainting Model (SD1.5)             | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/Lykon/dreamshaper-8-inpainting)         |
| JuggernautXL v9 Model  (SDXL)                      | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/RunDiffusion/Juggernaut-XL-v9)           |
| Flux.1-Schnell GGUF Models (Q4_K_S, Q8)                      | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md)                                             | [site](https://huggingface.co/city96/FLUX.1-schnell-gguf)           |
| Flux.1 Kontext[dev]                       | [license](https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-dev), | [site](https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/blob/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors)           |
| Inswapper                     | [license](https://huggingface.co/datasets/Gourieff/ReActor)                                              | [site](https://huggingface.co/Aitrepreneur/insightface) inswapper_128.onnx           |
| Latent Consistency Model (LCM) LoRA: SD1.5 | [license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [site](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5) |
| Latent Consistency Model (LCM) LoRA:SDXL   | [license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [site](https://huggingface.co/latent-consistency/lcm-lora-sdxl)     |
| Wan 2.1 Vace 14 B | [license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [site]() |
|    |  |      |
| CHAT |  |      |
| GPT-OSS 20B                      | [license]()                 | [site]()     |
| DeepSeek R1 Distilled Qwen Models                      | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md)                 | site [1.5B](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B) [7B](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B)    |
| Meta-Llama-3.1B-Instruct                     | [license]()                 | [site]()     |
| Llama-3.2-3B Instruct                      | [license]()                 | [site]()     |
| Phi3-mini-4k-instruct                      | [license](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/LICENSE)                 | [site](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct)     |
| Phi3.5-mini-4k-instruct                      | [license]()                 | [site]()     |
| Qwen/Qwen2-1.5B-Instruct                     | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md)                 | [site](https://huggingface.co/Qwen/Qwen2-1.5B-Instruct)     |
| Mistral-7B-Instruct-v0.3                     | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md)                 | [site](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3)     |
| bge-large-en-v1.5                          | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md)                 | [site](https://huggingface.co/BAAI/bge-large-en-v1.5)                         |


Be sure to check license terms for any model used in AI Playground especially taking note of any restrictions.

### Use Alternative Models
Check the [User Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf) for details or [watch this video](https://www.youtube.com/watch?v=1FXrk9Xcx2g) on how to add alternative Stable Diffusion models to AI Playground

### Notices and Disclaimers: 
For information on AI Playground terms, license and disclaimers, visit the project and files on GitHub repo:</br >
[License](https://github.com/intel/ai-playground/blob/main/LICENSE) | [Notices & Disclaimers](https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md)

The software may include third party components with separate legal notices or governed by other agreements, as may be described in the Third Party Notices file accompanying the software.


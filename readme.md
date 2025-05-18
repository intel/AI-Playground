# AI Playground

<a href="https://scan.coverity.com/projects/ai-playground">
  <img alt="Coverity Scan Build Status"
       src="https://scan.coverity.com/projects/30694/badge.svg"/>
</a>

![image](https://github.com/user-attachments/assets/ee1efc30-4dd1-4934-9233-53fba00c71bd)


This example is based on the xpu implementation of Intel® Arc™ GPU.

Welcome to AI Playground open source project and AI PC starter app for doing AI image creation, image stylizing, and chatbot on a PC powered by an Intel® Arc™ GPU. AI Playground leverages libraries from GitHub and Huggingface which may not be available in all countries world-wide.  AI Playground supports many Gen AI libraries and models including:
- Image Diffusion: Stable Diffusion 1.5, SDXL, Flux.1-Schnell, LTX-Video
- LLM: Safetensor PyTorch LLMs - DeepSeek R1 models, Phi3, Qwen2, Mistral, GGUF LLMs -  Llama 3.1, Llama 3.2: OpenVINO - TinyLlama, Mistral 7B, Phi3 mini, Phi3.5 mini

## README.md
- English (readme.md)

## Min Specs
AI Playground alpha and beta installers are currently available downloadable executables, or available as a source code from our Github repository.  To run AI Playground you must have a PC that meets the following specifications

*	Windows OS
*	Intel Core Ultra-H Processor, Intel Core Ultra-V processor OR Intel Arc GPU Series A or Series B (discrete) with 8GB of vRAM

## Installation - Packaged Installer: 
This is a single packaged installer for all supported hardware mentioned above. This installer simplifies the process for end users to install AI Playground on their PCs. Please note that while this makes the installation process easier, this is open-source beta software, and there may be component and version conflicts. Refer to the Troubleshooting section for known issues.

### Download the installer
:new: **AI Playground 2.5.0 Beta (all SKUs)** - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v2.5.0-beta) | [Download](https://github.com/intel/AI-Playground/releases/download/v2.5.0-beta/AI.Playground-2.5.0-beta.exe) :new:

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

### Prepare Python Environment

1. Install Miniforge to manage your Conda environment: https://github.com/conda-forge/miniforge

2. Create a Conda environment with Python 3.11 and libuv:
```
conda create -n cp311_libuv python=3.11 libuv -y
```

3. Locate the path to your newly created Conda environment:
```
conda env list | findstr cp311_libuv
```

4. In the `WebUI` directory, execute the `fetch-build-resources` script, replacing `<path_to_cp311_libuv_conda_env>` with the actual path you copied in the previous step:
```
npm run fetch-build-resources -- --conda_env_dir=<path_to_cp311_libuv_conda_env>
```

5. Run the `prepare-build` script:
```
npm run prepare-build
```

You should now have a basic Python environment located at `build-envs\online\prototype-python-env`.

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

The installer executable will be located in the `release` folder.

### (Optional) Create the offline resource package

To create the offline resource package for windows, run:

```
run `npm run prepare-offline-package:win -- --conda_env_dir=$PATH_TO_CONDA_ENV`
```

The offline package will be located in the `release` folder.

[More Detail](offline/README.md)

## Model Support
AI Playground supports PyTorch LLM, SD1.5, and SDXL models. AI Playground does not ship with any models but does make  models available for all features either directly from the interface or indirectly by the users downloading models from HuggingFace.co or CivitAI.com and placing them in the appropriate model folder. 

Models currently linked from the application 
| Model                                      | License                                                                                                                                                                      | Background Information/Model Card                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Dreamshaper 8 Model                        | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/Lykon/dreamshaper-8)                               |
| Dreamshaper 8 Inpainting Model             | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/Lykon/dreamshaper-8-inpainting)         |
| JuggernautXL v9 Model                      | [license](https://huggingface.co/spaces/CompVis/stable-diffusion-license)                                             | [site](https://huggingface.co/RunDiffusion/Juggernaut-XL-v9)           |
| Phi3-mini-4k-instruct                      | [license](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/LICENSE)                 | [site](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct)     |
| bge-large-en-v1.5                          | [license](https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md)                 | [site](https://huggingface.co/BAAI/bge-large-en-v1.5)                         |
| Latent Consistency Model (LCM) LoRA: SD1.5 | [license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [site](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5) |
| Latent Consistency Model (LCM) LoRA:SDXL   | [license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | [site](https://huggingface.co/latent-consistency/lcm-lora-sdxl)     |

Be sure to check license terms for any model used in AI Playground especially taking note of any restrictions.

### Use Alternative Models
Check the [User Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf) for details or [watch this video](https://www.youtube.com/watch?v=1FXrk9Xcx2g) on how to add alternative Stable Diffusion models to AI Playground

### Notices and Disclaimers: 
For information on AI Playground terms, license and disclaimers, visit the project and files on GitHub repo:</br >
[License](https://github.com/intel/ai-playground/blob/main/LICENSE) | [Notices & Disclaimers](https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md)

The software may include third party components with separate legal notices or governed by other agreements, as may be described in the Third Party Notices file accompanying the software.


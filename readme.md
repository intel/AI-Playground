# AI Playground

![image](https://github.com/user-attachments/assets/66086f2c-216e-4a79-8ff9-01e04db7e71d)

This example is based on the xpu implementation of Intel Arc A-Series dGPU and Ultra iGPU

Welcome to AI Playground beta open source project and AI PC starter app for doing AI image creation, image stylizing, and chatbot on a PC powered by an Intel® Arc™ GPU.  AI Playground leverages libraries from GitHub and Huggingface which may not be available in all countries world-wide.

## README.md
- English (readme.md)

## Min Specs
AI Playground beta is currently available as a packaged installer, or available as a source code from our Github repository.  To run AI Playground you must have a PC that meets the following specifications

*	Windows OS
*	Intel Core Ultra-H Processor (coming soon) OR Intel Arc GPU (discrete) with 8GB of vRAM

## Installation - Packaged Installer: 
AI Playground has multiple packaged installers, each specific to the hardware. 
1. Choose the correct installer (for Desktop systems with Intel Arc GPUs,or for Intel Core Ultra-H systems), download to your PC then run the installer.
2. The installer will have two phases.  It will first install components and environment from the installer. The second phase will pull in components from their source. </b >
This second phase of installation **will take several minutes** and require a steady internet connection.
3. On first run, the load screen will take up to a minute
4. Download the Users Guide for application information

*	AI Playground for Desktop-dGPU (ACM) - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v1.01beta) | [Download](https://github.com/intel/AI-Playground/releases/download/v1.01beta/AI.Playground-v1.01b-Desktop_dGPU.exe) 

*	AI Playground for Intel Core Ultra-H (MTL) - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v1.01beta.mtl) | [Download](https://github.com/intel/AI-Playground/releases/download/v1.01beta.mtl/AI.Playground-v1.01b-Mobile_MTL-H.exe) 

*	AI Playground for Intel Core Ultra 200V (LNL) - Coming soon  [watch video](https://www.youtube.com/watch?v=zDQn6cIcmKY) 

*	[AI Playground Users Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf)

IMPORTANT: We have noticed some systems require the VS C++ redistribution, often already installed on Windows systems. If AI Playground is hanging on the load screen , this may be the issue and can be resolved by installing VS C++ redist https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170

## Project Development
### Dev Environment Setup (backend, python)

1. Create and switch the conda environment and go to the service directory.

```cmd
conda create -n aipg_xpu python=3.10 -y
conda activate aipg_xpu
conda install libuv -y

cd service

@REM for Desktop-dGPU (e.g. A770)
pip install -r requriements-arc.txt

@REM for Intel Core Ultra-H (MTL)
pip install -r requriements-ultra.txt
```

2. Check whether the XPU environment is correct

```cmd
python -c "import torch; import intel_extension_for_pytorch as ipex; print(torch.__version__); print(ipex.__version__); [print(f'[{i}]: {torch.xpu.get_device_properties(i)}') for i in range(torch.xpu.device_count())];"
```

Example output:

```txt
2.1.0.post3+cxx11.abi
2.1.40+xpu
[0]: _DeviceProperties(name='Intel(R) Arc(TM) Graphics', platform_name='Intel(R) Level-Zero', dev_type='gpu', driver_version='1.3.29283', has_fp64=1, total_memory=14765MB, max_compute_units=112, gpu_eu_count=112)
```


### Linking Dev Environment to Project Environment

1. Switch to the root directory of the project. (AI-Playground)

2. Run the following command to view the path of the conda virtual environment

on windows
```
conda env list|findstr aipg_xpu
```

3. Based on the obtained environment path, run the following command to create an env file link
on windows
```
mklink /J "./env" "{aipg_xpu_env_path}"
```

### WebUI (nodejs + electron)

1. Install Nodejs development environment, you can get it from https://nodejs.org/en/download.

2. Switch to the WebUI directory and install all Nodejs dependencies. 
```
npm install
```

3. In the WebUI directory, run the below command to get started with development
```
npm run dev
```

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


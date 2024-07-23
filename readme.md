# AI Playground

![image](https://github.com/user-attachments/assets/66086f2c-216e-4a79-8ff9-01e04db7e71d)

This example is based on the xpu implementation of Intel Arc A-Series dGPU and Ultra iGPU

Welcome to AI Playground beta open source project and AI PC starter app for doing AI image creation, image stylizing, and chatbot on a PC powered by an Intel® Arc™ GPU.  AI Playground leverages libraries from GitHub and Huggingface which may not be available in all countries world-wide.

# README.md
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

*	AI Playground for Desktop-dGPU - [Release Notes](https://github.com/intel/AI-Playground/releases/tag/v1.0beta) | [Download](https://github.com/intel/AI-Playground/releases/download/v1.0beta/AI.Playground-v1.0b-Desktop_dGPU.exe)

*	AI Playground for Intel Core Ultra-H  - coming soon.

*	[AI Playground Users Guide](https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf)


## Install from Source
### service (python)

1. Create and switch the conda environment and go to the service directory.
```cmd
conda create -n aipg_xpu python=3.10 -y
activate aipg_xpu
pip install -r requirements.txt
```

3. Download the Intel ONEAPI AOT environment. Depending on your hardware, download all whl files from the link below.

Ultra iGPU https://github.com/Nuullll/intel-extension-for-pytorch/releases/tag/v2.1.20%2Bmtl%2Boneapi

The Arc A - Series dGPU https://github.com/Nuullll/intel-extension-for-pytorch/releases/tag/v2.1.10%2Bxpu

Install all downloaded whl files using the pip instal command

4. Check whether the XPU environment is correct
```cmd
python -c "import torch; import intel_extension_for_pytorch as ipex; print(torch.version); print(ipex.version); [print(f'[{i}]: {torch.xpu.get_device_properties(i)}') for i in range(torch.xpu.device_count())];"
```

env pythoon directory created

1. Switch to the root directory of the project, that is, the service directory and WebUI directory

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

2. Switch to the WebUI directory and install all Nodejs dependent libraries. Execute a command
```
npm install
```

3. In the WebUI directory, run the UI program
```
npm run dev
```

The software may include third party components with separate legal notices or governed by other agreements, as may be described in the Third Party Notices file accompanying the software.

Notices and Disclaimers: For information on AI Playground terms, license and disclaimers, visit the project and files on GitHub repo:</br >
[License](https://github.com/intel/ai-playground/blob/main/LICENSE) | [Notices & Disclaimers](https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md)

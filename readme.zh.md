# AI 游乐场 (AI Playground)

欢迎来到 AI 游乐场开源项目和 AI PC 生成式AI应用套件。该应用为聊天、代码辅助、文档搜索、图像分析、图像和视频生成提供完整的生成式AI功能。所有功能完全离线运行，由你PC中的英特尔® Core™ Ultra处理器和内置英特尔Arc GPU或英特尔Arc™ dGPU系列A或B（配备8GB+显存）提供支持。

## 产品概述

AI 游乐场是云端工具（如Gemini、ChatGPT和Grok）的离线替代方案。AI 游乐场整合了GitHub和Huggingface上的多个库，包括：

- **图像扩散 (PyTorch)**：Stable Diffusion 1.5、SDXL、Flux.1-Schnell、Flux.1 Kontext[dev]、Z-Image、Wan2.1 VACE、LTX-Video
- **大语言模型**：
  - GGUF (Llama.cpp Vulkan)：Gemma4、Qwen3.5、Qwen3 VL、GPT-OSS 20B、DeepSeek R1 Distilled、Phi3、Mistral 7B、Llama 3.2
  - OpenVINO：TinyLlama、Mistral 7B、Phi3 mini、Phi3.5 mini、DeepSeek R1 Distill (1.5B, 7B)

## 主要特性

作为本地AI服务替代方案，AI 游乐场为消费者和AI爱好者提供了易用直观的界面，可以访问丰富多样的生成式AI功能。你可以完全离线使用，无需上传敏感或个人数据到第三方网站，免费使用，且无需安装和管理多个AI后端框架。主要特性包括：

### 💬 最新聊天模型
支持Gemma4、Qwen3.5、Qwen 3 VL、Mistral 7B、DeepSeek R1和GPT-OSS等多种聊天模型

### 👁️ 视觉、推理和RAG
- 使用Qwen3 VL模型分析图像
- 使用GPT-OSS 20B进行推理编程
- 使用Mistral 7B Instruct进行文档RAG
- 支持对视觉和文本内容的深度分析和理解

### 🎨 图像生成
支持Stable Diffusion 1.5、SDXL、Flux.1和Z-image模型，从快速低分辨率草稿到高质量图像生成应有尽有

### ✏️ 图像编辑
无需订阅，完全私密控制。支持放大、内绘、外绘、2D转3D网格等多种编辑方式，可以编辑个人照片，或将草稿和生成的图像提升到新的水平

---

## 最低配置要求

AI Playground现提供可下载的可执行文件（alpha和beta版本），或可从Github仓库获取源代码。运行AI Playground需要满足以下配置要求：

- **操作系统**：Windows OS
- **处理器**：英特尔 Core Ultra 系列3、系列2H、系列2V或系列1 H处理器
- **显卡**：英特尔 Arc GPU 系列A或系列B（独立显卡），配备8GB+显存

---

## 安装 - 打包安装程序

这是一个适用于上述所有支持硬件的单一打包安装程序。该安装程序简化了最终用户在PC上安装AI Playground的过程。请注意，虽然这使安装过程更加简单，但这是开源测试版软件，可能存在组件和版本冲突。请参考故障排除部分了解已知问题。

### 下载安装程序

**🆕 AI Playground 3.1.0 alpha (全SKU)** - [发布说明](https://github.com/intel/AI-Playground/releases) | [下载](https://github.com/intel/AI-Playground/releases)

### v3.x 安装过程

1. 安装程序仅安装Electron前端，因此完成速度很快
2. 首次运行时，AI Playground设置窗口会出现，你可以选择硬件模式和所需的后端组件以使AI Playground正常运行。此过程需要强大的开放网络，可能需要几分钟
3. 下载用户指南获取应用信息：[AI Playground用户指南](https://github.com/intel/AI-Playground/blob/main/AI%20Playground%20Users%20Guide.pdf)

### 安装故障排除

以下是已知可能导致安装受阻或中断的情况。请查看以下内容解决安装问题。如果安装问题仍然存在，请按CTRL+SHIFT+I生成日志副本，选择控制台标签页并复制安装失败处的最后几条日志条目。通过此处的问题标签页、英特尔内部人士Discord或英特尔支持网站的图形论坛将这些详情提供给我们。

#### 1️⃣ Llama.cpp 嵌入问题
在此版本发布时，Llama.cpp嵌入可能存在以下问题：
- 最新驱动程序可能需要使用DDU清理驱动程序缓存
- 防病毒软件 - 读取和写入嵌入缓存所需的功能可能未正确安装：禁用防病毒软件，重启系统

#### 2️⃣ 重启
已发现超时问题，显示为安装失败，但重新启动AI Playground后会解决

#### 3️⃣ 验证英特尔Arc GPU
确保你的系统拥有带最新驱动的英特尔Arc GPU。打开Windows开始菜单，输入"设备管理器"，在显示适配器下查看你的GPU设备名称。应该显示英特尔Arc GPU。如果显示"Intel(R) Graphics"，说明你的系统没有内置英特尔Arc GPU，不符合最低配置要求。如果你的GPU是英特尔Arc A或B系列等独立显卡，则可以通过在设备管理器中禁用集成显卡来排除问题

#### 4️⃣ 安装中断
后端组件的在线安装可能被IT网络、防火墙或睡眠设置中断或阻止。确保你处于开放网络、防火墙已关闭，且睡眠设置设为通电时保持唤醒

#### 5️⃣ 缺少库文件
某些Windows系统可能缺少必要的库。可以通过从[微软官网](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)安装64位VC++再发行版来修复。建议在更新图形驱动程序后执行此操作，然后安装AI Playground

#### 6️⃣ Python冲突
某些装有现有Python环境的PC可能与AI Playground安装冲突，导致因系统中Python的版本或位置不正确而安装错误或冲突的包。通常可以通过卸载Python环境、重启系统然后重新安装AI Playground来解决

#### 7️⃣ 临时文件
如果因以上任何问题导致安装中断，可能会留下临时安装文件，在这些文件存在的情况下尝试安装会阻止安装进行。删除这些文件或执行AI Playground的全新安装以解决此问题

---

## 项目开发

### 检出源代码

开始之前，克隆仓库并导航到项目目录：

```cmd
git clone -b dev https://github.com/intel/AI-Playground.git
cd AI-Playground
```

### 安装 Node.js 依赖项

1. 从 [Node.js官网](https://nodejs.org/en/download) 安装Node.js开发环境

2. 导航到 `WebUI` 目录并安装所有Node.js依赖项：

```cmd
cd WebUI
npm install
```

### 获取外部资源

在 `WebUI` 目录中，执行 `fetch-external-resources` 脚本下载所需的外部资源：

这将把 `uv`（Python包管理器）和其他必需工具下载到 `build/resources/` 目录

### 启动应用程序

以开发模式运行应用程序，执行：

```
npm run dev
```

### （可选）构建安装程序

要构建安装程序，运行：

```
npm run build
```

安装程序可执行文件将位于 `build/electron` 文件夹中

---

## 模型支持

AI Playground不预装任何生成式AI模型，但可以通过应用程序界面直接提供模型，或用户可以从HuggingFace.co或CivitAI.com下载模型并将其放在相应的模型文件夹中来间接提供模型。

**应用程序当前链接的模型请参考模型注册表**

> 请确保检查在AI Playground中使用的任何模型的许可证条款，特别要注意任何限制

### 使用其他模型

查看[用户指南](https://github.com/intel/AI-Playground/blob/main/AI%20Playground%20Users%20Guide.pdf)了解详情，或[观看此视频](https://www.youtube.com/watch?v=1FXrk9Xcx2g)了解如何向AI Playground添加其他Stable Diffusion模型

---

**祝你使用愉快！** 🚀
import fs from 'node:fs'
import path from 'node:path'
import type { ModelPaths, ModelLists } from '@/assets/js/store/models'
import { llmBackendTypes } from '../src/types/shared'

export class PathsManager {
  modelPaths: ModelPaths = {
    llm: '',
    ggufLLM: '',
    openvinoLLM: '',
    embedding: '',
    stableDiffusion: '',
    inpaint: '',
    lora: '',
    vae: '',
  }
  configPath: string

  constructor(configPath: string) {
    this.configPath = configPath
    this.loadConfig()
  }
  loadConfig() {
    this.initModelPaths(JSON.parse(fs.readFileSync(this.configPath).toString()) as ModelPaths)
  }
  updateModelPaths(modelPaths: ModelPaths) {
    this.initModelPaths(modelPaths)
    const workDir = process.cwd()
    const savePaths = Object.assign({}, this.modelPaths)
    Object.keys(savePaths).forEach((key) => {
      let modelPath = path.resolve(modelPaths[key])
      //if the path is in the workDir, save the relative path
      if (modelPath.startsWith(workDir)) {
        modelPath = path.relative(workDir, modelPath)
      }
      savePaths[key] = modelPath
    })
    fs.writeFileSync(this.configPath, JSON.stringify(savePaths, null, 4))
  }
  private initModelPaths(modelPaths: ModelPaths) {
    Object.keys(this.modelPaths).forEach((key) => {
      if (key in modelPaths) {
        const modelPath = path.resolve(modelPaths[key])
        this.modelPaths[key] = modelPath
      }
    })
  }
  scanAll(): ModelLists {
    try {
      const model_settings: ModelLists = {
        stableDiffusion: this.scanSDModelLists(),
        inpaint: this.scanInpaint(),
        llm: this.scanLLMModels(),
        lora: this.scanLora(),
        vae: [],
        scheduler: [],
        embedding: this.scanEmbedding()
          .filter((model) => model.backend === 'ipexLLM')
          .map((model) => model.name),
      }
      return model_settings
    } catch (ex) {
      fs.appendFileSync(path.join(path.dirname(this.configPath), 'debug.log'), `${ex}\r\n`)
      throw ex
    }
  }
  scanSDModelLists(returnDefaults = true) {
    const models = returnDefaults ? ['Lykon/dreamshaper-8', 'RunDiffusion/Juggernaut-XL-v9'] : []
    const dir = this.modelPaths.stableDiffusion
    if (fs.existsSync(dir)) {
      const modelsSet = new Set(models)
      fs.readdirSync(dir).forEach((enumPath) => {
        const realPath = path.join(dir, enumPath)
        const pathStat = fs.statSync(realPath)
        if (pathStat.isFile() && (enumPath.endsWith('.bin') || enumPath.endsWith('.safetensors'))) {
          const modelName = enumPath
          if (!modelsSet.has(modelName)) {
            modelsSet.add(modelName)
            models.push(modelName)
          }
        } else if (
          pathStat.isDirectory() &&
          fs.existsSync(path.join(realPath, 'model_index.json'))
        ) {
          const modelName = enumPath.replace('---', '/')
          if (!modelsSet.has(modelName)) {
            modelsSet.add(modelName)
            models.push(modelName)
          }
        }
      })
    } else {
      fs.mkdirSync(dir, { recursive: true })
    }
    return models
  }
  scanLLMModels() {
    const dir = this.modelPaths.llm
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const modelsSet = fs
      .readdirSync(dir)
      .filter((subDir) => {
        const fullpath = path.join(dir, subDir)
        return fs.statSync(fullpath).isDirectory() && fs.existsSync(path.join(fullpath))
      })
      .map((subDir) => subDir.replace('---', '/'))
      .reduce((set, modelName) => set.add(modelName), new Set<string>())

    return [...modelsSet]
  }
  scanGGUFLLMModels() {
    const dir = this.modelPaths.ggufLLM
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    console.log('getting models', dir)
    const modelsSet = fs
      .readdirSync(dir, { encoding: 'utf-8', recursive: true })
      .filter((pathName) => pathName.endsWith('.gguf'))
      .map((path) => path.replace('---', '/'))
      .map((path) => path.replace('\\', '/'))
      .reduce((acc, pathname) => acc.add(pathname), new Set<string>())

    return [...modelsSet]
  }
  scanOpenVINOModels() {
    const dir = this.modelPaths.openvinoLLM
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    console.log('getting models', dir)
    const modelsSet = fs
      .readdirSync(dir)
      .filter((subDir) => {
        const fullpath = path.join(dir, subDir)
        return fs.statSync(fullpath).isDirectory() && fs.existsSync(path.join(fullpath))
      })
      .map((subDir) => subDir.replace('---', '/'))
      .reduce((set, modelName) => set.add(modelName), new Set<string>())

    return [...modelsSet]
  }
  scanLora(returnDefaults = true) {
    const models = returnDefaults
      ? ['None', 'latent-consistency/lcm-lora-sdxl', 'latent-consistency/lcm-lora-sdv1-5']
      : []
    const loraDir = this.modelPaths.lora
    if (fs.existsSync(loraDir)) {
      const modelsSet = new Set(models)
      fs.readdirSync(loraDir).forEach((pathname) => {
        const fullPath = path.join(loraDir, pathname)
        if (fs.statSync(fullPath).isDirectory()) {
          if (
            fs.existsSync(path.join(fullPath, 'pytorch_lora_weights.safetensors')) ||
            fs.existsSync(path.join(fullPath, 'pytorch_lora_weights.bin'))
          ) {
            const modelName = pathname.replace('---', '/')
            if (!modelsSet.has(modelName)) {
              modelsSet.add(modelName)
              models.push(modelName)
            }
          }
        } else if (pathname.endsWith('.safetensors') || pathname.endsWith('.bin')) {
          const modelName = pathname
          if (!modelsSet.has(modelName)) {
            modelsSet.add(modelName)
            models.push(modelName)
          }
        }
      })
    } else {
      fs.mkdirSync(loraDir, { recursive: true })
    }
    return models
  }

  scanEmbedding(): Model[] {
    const embeddingModels: Model[] = []
    llmBackendTypes.forEach((backend) => {
      const dir = path.join(this.modelPaths.embedding, '..', backend)
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach((item) => {
          embeddingModels.push({
            name: item.replace('---', '/'),
            downloaded: true,
            type: 'embedding',
            default: false,
            backend: backend,
          })
        })
      } else {
        fs.mkdirSync(dir, { recursive: true })
      }
    })
    return embeddingModels
  }

  scanInpaint(returnDefaults = true) {
    const models = returnDefaults ? ['Lykon/dreamshaper-8-inpainting'] : []
    const dir = this.modelPaths.inpaint
    if (fs.existsSync(dir)) {
      const modelsSet = new Set(models)
      fs.readdirSync(dir).forEach((enumPath) => {
        const realPath = path.join(dir, enumPath)
        const pathStat = fs.statSync(realPath)
        if (pathStat.isFile() && (enumPath.endsWith('.bin') || enumPath.endsWith('.safetensors'))) {
          const modelName = enumPath
          if (!modelsSet.has(modelName)) {
            modelsSet.add(modelName)
            models.push(modelName)
          }
        } else if (
          pathStat.isDirectory() &&
          fs.existsSync(path.join(realPath, 'model_index.json'))
        ) {
          const modelName = enumPath.replace('---', '/')
          if (!modelsSet.has(modelName)) {
            modelsSet.add(modelName)
            models.push(modelName)
          }
        }
      })
    } else {
      fs.mkdirSync(dir, { recursive: true })
    }
    return models
  }
}

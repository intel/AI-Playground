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
        llm: this.scanLLMModels(),
        embedding: [],
      }
      return model_settings
    } catch (ex) {
      fs.appendFileSync(path.join(path.dirname(this.configPath), 'debug.log'), `${ex}\r\n`)
      throw ex
    }
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
}

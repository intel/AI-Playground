import fs from "node:fs";
import path from "node:path";

export class PathsManager {
    modelPaths: ModelPaths = {
        llm: "",
        embedding: "",
        stableDiffusion: "",
        inpaint: "",
        lora: "",
        vae: "",
    }
    configPath: string

    constructor(configPath: string) {
        this.configPath = configPath;
        this.loadConfig();
    }
    loadConfig() {
        this.initModelPaths(JSON.parse(fs.readFileSync(this.configPath).toString()) as ModelPaths);
    }
    updateModelPahts(modelPaths: ModelPaths) {
        this.initModelPaths(modelPaths);
        const workDir = process.cwd();
        const savePaths = Object.assign({}, this.modelPaths);
        Object.keys(savePaths).forEach((key) => {
            let modelPath = path.resolve(modelPaths[key]);
            //if the path is in the workDir, save the relative path
            if (modelPath.startsWith(workDir)) {
                modelPath = path.relative(workDir, modelPath);
            }
            savePaths[key] = modelPath;
        });
        fs.writeFileSync(this.configPath, JSON.stringify(savePaths, null, 4));
    }
    private initModelPaths(modelPaths: ModelPaths) {
        Object.keys(this.modelPaths).forEach((key) => {
            if (key in modelPaths) {
                const modelPath = path.resolve(modelPaths[key]);
                this.modelPaths[key] = modelPath;
            }
        });
    }
    sacanAll(): ModelLists {
        try {
            const model_settings: ModelLists = {
                stableDiffusion: this.scanSDModleLists(),
                inpaint: this.scanInpaint(),
                llm: this.scanLLMModles(),
                lora: this.scanLora(),
                vae: [],
                scheduler: [],
                embedding: this.scanEmbedding()
            };
            return model_settings;
        } catch (ex) {
            fs.appendFileSync(path.join(path.dirname(this.configPath), "debug.log"), `${ex}\r\n`);
            throw ex;
        }
    }
    scanSDModleLists(returnDefaults = true) {
        const models = returnDefaults ? [
            "Lykon/dreamshaper-8",
            "RunDiffusion/Juggernaut-XL-v9",
        ] : [];
        const dir = this.modelPaths.stableDiffusion;
        if (fs.existsSync(dir)) {

            const modelsSet = new Set(models);
            fs.readdirSync(dir).forEach(enumPath => {
                const realPath = path.join(dir, enumPath);
                const pathStat = fs.statSync(realPath);
                if (pathStat.isFile() && (
                    enumPath.endsWith(".bin") || enumPath.endsWith(".safetensors")
                )) {
                    const modelName = enumPath;
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                } else if (pathStat.isDirectory() && fs.existsSync(
                    path.join(realPath, "model_index.json")
                )) {
                    const modelName = enumPath.replace("---", "/")
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                }
            });
        }
        else {
            fs.mkdirSync(dir, { recursive: true });
        }
        return models
    }
    scanLLMModles(returnDefaults = true) {
        const models = returnDefaults ? [
            "microsoft/Phi-3-mini-4k-instruct",
        ] : [];
        const dir = this.modelPaths.llm;
        if (fs.existsSync(dir)) {
            const modelsSet = new Set(models);
            fs.readdirSync(dir).forEach(pathname => {
                const fullPath = path.join(dir, pathname);
                if (fs.statSync(fullPath).isDirectory() && fs.existsSync(
                    path.join(fullPath)
                )) {
                    const modelName = pathname.replace("---", "/")
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                }
            });
        }
        else {
            fs.mkdirSync(dir, { recursive: true });
        }
        return models
    }
    scanLora(returnDefaults = true) {
        const models = returnDefaults ? [
            "None",
            "latent-consistency/lcm-lora-sdxl",
            "latent-consistency/lcm-lora-sdv1-5",
        ] : [];
        const loraDir = this.modelPaths.lora;
        if (fs.existsSync(loraDir)) {
            const modelsSet = new Set(models);
            fs.readdirSync(loraDir).forEach(pathname => {
                const fullPath = path.join(loraDir, pathname);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (fs.existsSync(path.join(fullPath, "pytorch_lora_weights.safetensors")) || fs.existsSync(path.join(fullPath, "pytorch_lora_weights.bin"))) {
                        const modelName = pathname.replace("---", "/")
                        if (!modelsSet.has(modelName)) {
                            modelsSet.add(modelName)
                            models.push(modelName)
                        }
                    }
                }
                else if (pathname.endsWith(".safetensors") || pathname.endsWith(".bin")) {
                    const modelName = pathname;
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                }
            });
        }
        else {
            fs.mkdirSync(loraDir, { recursive: true });
        }
        return models
    }
    scanEmbedding(returnDefaults = true) {
        return returnDefaults ? [
            "BAAI/bge-large-en-v1.5",
            "BAAI/bge-large-zh-v1.5"
        ] : [];
    }
    scanInpaint(returnDefaults = true) {
        const models = returnDefaults ? [
            "Lykon/dreamshaper-8-inpainting"
        ] : [];
        const dir = this.modelPaths.inpaint;
        if (fs.existsSync(dir)) {
            const modelsSet = new Set(models);
            fs.readdirSync(dir).forEach(enumPath => {
                const realPath = path.join(dir, enumPath);
                const pathStat = fs.statSync(realPath);
                if (pathStat.isFile() && (
                    enumPath.endsWith(".bin") || enumPath.endsWith(".safetensors")
                )) {
                    const modelName = enumPath;
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                } else if (pathStat.isDirectory() && fs.existsSync(
                    path.join(realPath, "model_index.json")
                )) {
                    const modelName = enumPath.replace("---", "/")
                    if (!modelsSet.has(modelName)) {
                        modelsSet.add(modelName)
                        models.push(modelName)
                    }
                }
            });
        }
        else {
            fs.mkdirSync(dir, { recursive: true });
        }
        return models
    }
}
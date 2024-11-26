import { defineStore } from "pinia";
import { useImageGeneration } from "./imageGeneration";
import { useGlobalSetup } from "./globalSetup";
import { Const } from "../const";
import { useModels } from "./models";
import { util } from "../util";
import { SSEProcessor } from "../sseProcessor";
import { useI18N } from "./i18n";
import { toast } from "../toast";

type BackendParams = {
    mode: number,
    device: string,
    prompt: string,
    model_repo_id: string,
    negative_prompt: string,
    generate_number: number,
    inference_steps: number,
    guidance_scale: number,
    seed: number,
    height: number,
    width: number,
    lora: string,
    scheduler: string,
    image_preview: boolean,
    safe_check: boolean
}

export const useStableDiffusion = defineStore("stableDiffusion", () => {

    const imageGeneration = useImageGeneration();
    const globalSetup = useGlobalSetup();
    const i18nState = useI18N().state;
    const models = useModels();

    let abortContooler: AbortController | null;
    const generateParams = ref(new Array<KVObject>());

    async function generate() {
        if (imageGeneration.processing) { return; }
        try {
            imageGeneration.processing = true;
            await checkModel();
            const defaultBackendParams = {
                mode: 0,
                device: globalSetup.modelSettings.graphics,
                prompt: imageGeneration.prompt,
                model_repo_id: `stableDiffusion:${imageGeneration.imageModel}`,
                negative_prompt: imageGeneration.negativePrompt,
                generate_number: imageGeneration.batchSize,
                inference_steps: imageGeneration.inferenceSteps,
                guidance_scale: imageGeneration.guidanceScale,
                seed: imageGeneration.seed,
                height: imageGeneration.height,
                width: imageGeneration.width,
                lora: imageGeneration.lora,
                scheduler: imageGeneration.scheduler,
                image_preview: imageGeneration.imagePreview,
                safe_check: imageGeneration.safeCheck
            };

            await sendGenerate(defaultBackendParams);
        } catch (ex) {
        } finally {
            imageGeneration.processing = false;
        }
    }

    async function checkModel() {
        return new Promise<void>(async (resolve, reject) => {
            const checkList: CheckModelExistParam[] = [{ repo_id: globalSetup.modelSettings.sd_model, type: Const.MODEL_TYPE_STABLE_DIFFUSION }];
            if (globalSetup.modelSettings.lora != "None") {
                checkList.push({ repo_id: globalSetup.modelSettings.lora, type: Const.MODEL_TYPE_LORA })
            }
            if (globalSetup.modelSettings.imagePreview) {
                checkList.push({ repo_id: "madebyollin/taesd", type: Const.MODEL_TYPE_PREVIEW })
                checkList.push({ repo_id: "madebyollin/taesdxl", type: Const.MODEL_TYPE_PREVIEW })
            }
            const result = await globalSetup.checkModelExists(checkList);
            const downloadList: CheckModelExistParam[] = [];
            for (const item of result) {
                if (!item.exist) {
                    downloadList.push({ repo_id: item.repo_id, type: item.type })
                }
            }
            await models.download(downloadList);
            resolve();
        });
    }


    function finishGenerate() {
        imageGeneration.processing = false;
    }

    async function dataProcess(line: string) {
        util.log(`SD data: ${line}`);
        const dataJson = line.slice(5);
        const data = JSON.parse(dataJson) as SDOutCallback;
        switch (data.type) {
            case "image_out":
                imageGeneration.currentState = "image_out";
                if (!data.safe_check_pass) {
                    data.image = '/src/assets/image/nsfw_result_detected.png'
                }
                await imageGeneration.updateDestImage(data.index, data.image);
                generateParams.value.push(data.params);
                imageGeneration.generateIdx++;
                break;
            case "step_end":
                imageGeneration.currentState = "generating";
                imageGeneration.stepText = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`;
                if (data.image) {
                    await imageGeneration.updateDestImage(data.index, data.image);
                }
                if (data.step == 0) {
                    imageGeneration.previewIdx = data.index;
                }
                break;
            case "load_model":
                imageGeneration.currentState = "load_model";
                break;
            case "load_model_components":
                imageGeneration.currentState = data.event == "finish" ? "generating" : "load_model_components";
                break;
            case "error":
                imageGeneration.processing = false;
                imageGeneration.currentState = "error";
                switch (data.err_type) {
                    case "not_enough_disk_space":
                        toast.error(i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace("{requires_space}", data.requires_space).replace("{free_space}", data.free_space));
                        break;
                    case "download_exception":
                        toast.error(i18nState.ERR_DOWNLOAD_FAILED);
                        break;
                    case "runtime_error":
                        toast.error(i18nState.ERROR_RUNTIME_ERROR);
                        break;
                    case "unknow_exception":
                        toast.error(i18nState.ERROR_GENERATE_UNKONW_EXCEPTION);
                        break;
                }
                break;
        }
    }

    async function sendGenerate(defaultBackendParams: BackendParams) {
        try {
            imageGeneration.processing = true;
            if (!abortContooler) {
                abortContooler = new AbortController()
            }
            const response = await fetch(`${useGlobalSetup().apiHost}/api/sd/generate`, {
                method: "POST",
                body: util.convertToFormData(defaultBackendParams),
                signal: abortContooler.signal
            })
            const reader = response.body!.getReader();
            await new SSEProcessor(reader, dataProcess, finishGenerate).start();
        } finally {
            imageGeneration.processing = false;
        }
    }

    async function stop() {
        if (imageGeneration.processing && !imageGeneration.stopping) {
            imageGeneration.stopping = true;
            await fetch(`${globalSetup.apiHost}/api/sd/stopGenerate`);
            if (abortContooler) {
                abortContooler.abort();
                abortContooler = null;
            }
            imageGeneration.processing = false;
            imageGeneration.stopping = false;
        }
    }


    return {
        generateParams,
        generate,
        stop,
    }
}, {
    persist: {
        pick: ['settings', 'hdWarningDismissed']
    }
});

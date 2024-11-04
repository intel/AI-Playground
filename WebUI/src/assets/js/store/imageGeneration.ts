import { defineStore } from "pinia";
import { effect } from "vue";
import z from "zod";
import { useComfyUi } from "./comfyUi";
import { useStableDiffusion } from "./stableDiffusion";
import { useI18N } from "./i18n";
import { Const } from "../const";
import { useGlobalSetup } from "./globalSetup";

export type StableDiffusionSettings = {
    resolution: 'standard' | 'hd' | 'manual', // ~ modelSettings.resolution 0, 1, 3
    quality: 'standard' | 'high' | 'fast', // ~ modelSettings.quality 0, 1, 2
    imageModel: string,
    inpaintModel: string,
    negativePrompt: string,
    batchSize: number, // ~ modelSettings.generateNumber
    pickerResolution?: string,
    width: number,
    height: number,
    guidanceScale: number,
    inferenceSteps: number,
    seed: number,
    lora: string | null,
    scheduler: string | null,
    imagePreview: boolean,
    safetyCheck: boolean
}

const SettingsSchema = z.object({
    imageModel: z.string(),
    inpaintModel: z.string(),
    negativePrompt: z.string(),
    batchSize: z.number(),
    width: z.number(),
    height: z.number(),
    prompt: z.string(),
    resolution: z.string(),
    guidanceScale: z.number(),
    inferenceSteps: z.number(),
    seed: z.number(),
    lora: z.string().nullable(),
    scheduler: z.string().nullable(),
    imagePreview: z.boolean(),
    safetyCheck: z.boolean()
})

const SettingSchema = SettingsSchema.keyof();

export type Setting = z.infer<typeof SettingSchema>

// const SettingsSchema = z.enum([
//     'imageModel',
//     'inpaintModel',
//     'guidanceScale',
//     'inferenceSteps',
//     'seed',
//     'negativePrompt',
//     'batchSize',
//     'imagePreview',
//     'safetyCheck',
//     'width',
//     'height',
//     'scheduler',
//     'lora',
// ]);

const WorkflowRequirementSchema = z.enum(['high-vram'])
export type WorkflowRequirement = z.infer<typeof WorkflowRequirementSchema>
const ComfyUIApiWorkflowSchema = z.record(z.string(), z.object({
    inputs: z.object({
        text: z.string().optional(),
    }).passthrough().optional(),
}).passthrough());
export type ComfyUIApiWorkflow = z.infer<typeof ComfyUIApiWorkflowSchema>;
const WorkflowSchema = z.object({
    name: z.string(),
    backend: z.enum(['default', 'comfyui']),
    tags: z.array(z.string()),
    requirements: z.array(WorkflowRequirementSchema),
    inputs: z.array(z.object({
        name: z.string(),
        type: z.enum(['image', 'mask', 'text'])
    })),
    outputs: z.array(z.object({
        name: z.string(),
        type: z.literal('image')
    })),
    defaultSettings: SettingsSchema.partial().optional(),
    displayedSettings: z.array(SettingsSchema.keyof()),
    modifiableSettings: z.array(SettingsSchema.keyof()),
    dependencies: z.array(z.unknown()).optional(),
    comfyUiApiWorkflow: ComfyUIApiWorkflowSchema.optional()
})
export type Workflow = z.infer<typeof WorkflowSchema>;

const globalDefaultSettings = {
    width: 512,
    height: 512,
    inferenceSteps: 20,
    resolution: '512x512',
    batchSize: 1,
    negativePrompt: 'nsfw',
    imageModel: 'Lykon/dreamshaper-8',
    inpaintModel: 'Lykon/dreamshaper-8-inpainting',
    guidanceScale: 7,
    lora: "None",
    scheduler: 'DPM++ SDE Karras',
}

export const useImageGeneration = defineStore("imageGeneration", () => {

    const comfyUi = useComfyUi();
    const stableDiffusion = useStableDiffusion();
    const globalSetup = useGlobalSetup();
    const i18nState = useI18N().state;

    const workflows = ref<Workflow[]>(predefinedWorkflows);
    const activeWorkflowName = ref<string | null>('Standard');
    const activeWorkflow = computed(() => {
        console.log('### activeWorkflowName', activeWorkflowName.value)
        return workflows.value.find(w => w.name === activeWorkflowName.value) ?? predefinedWorkflows[0]
    });
    const processing = ref(false);
    const stopping = ref(false);

    const prompt = ref<string>('');
    const negativePrompt = ref<string>('nsfw');
    const seed = ref<number>(-1);
    const width = ref<number>(512);
    const height = ref<number>(512);
    const batchSize = ref<number>(1);
    const imagePreview = ref<boolean>(true);
    const safeCheck = ref<boolean>(true); // TODO wire up to settings
    const scheduler = ref<string>("None");
    const imageModel = ref(activeWorkflow.value.defaultSettings?.imageModel ?? globalDefaultSettings.imageModel);
    const lora = ref<string>("None");
    const guidanceScale = ref<number>(7.5);

    const backend = computed({
        get() {
          return activeWorkflow.value.backend;
        },
        set(newValue) {
            activeWorkflowName.value = workflows.value.find(w => w.backend === newValue)?.name ?? activeWorkflowName.value;
        }
      });

    const resolution = computed({
        get() {
          return `${width.value}x${height.value}`
        },
        set(newValue) {
            [width.value, height.value] = newValue.split('x').map(Number);
        }
      })

    const inferenceSteps = ref<number>(20);

    const settings = { inferenceSteps, width, height, resolution, batchSize, negativePrompt, lora, scheduler, guidanceScale, imageModel };
    type ModifiableSettings = keyof typeof settings;

    const settingsPerWorkflow = ref<Record<string, Workflow['defaultSettings']>>({});

    const isModifiable = (settingName: ModifiableSettings) => activeWorkflow.value.modifiableSettings.includes(settingName);

    watch([activeWorkflowName, workflows], () => {
        console.log('loading settings');
        const getSavedOrDefault = (settingName: ModifiableSettings) => {
            if (!activeWorkflowName.value) return;
            let saved = undefined;
            if (isModifiable(settingName)) {
                saved = settingsPerWorkflow.value[activeWorkflowName.value]?.[settingName];
                console.log('got saved', {settingName, saved});
            }
            settings[settingName].value = saved ?? activeWorkflow.value?.defaultSettings?.[settingName] ?? globalDefaultSettings[settingName];
        }
        
        getSavedOrDefault('inferenceSteps');
        getSavedOrDefault('width');
        getSavedOrDefault('height');
        getSavedOrDefault('resolution');
        getSavedOrDefault('batchSize');
        getSavedOrDefault('negativePrompt');
        getSavedOrDefault('lora');
        getSavedOrDefault('scheduler');
        getSavedOrDefault('guidanceScale');
        getSavedOrDefault('imageModel');

    }, {});

    watch(resolution, () => {
        const [width, height] = resolution.value.split('x').map(Number);
        settings.width.value = width;
        settings.height.value = height;
    });

    watch([inferenceSteps, width, height], () => {
        console.log('saving to settingsPerWorkflow');
        const saveToSettingsPerWorkflow = (settingName: ModifiableSettings) => {
            if (!activeWorkflowName.value) return;
            if (isModifiable(settingName)) {
                settingsPerWorkflow.value[activeWorkflowName.value] = {
                    ...settingsPerWorkflow.value[activeWorkflowName.value],
                    [settingName]: settings[settingName].value
                }
                console.log('saving', {settingName, value: settings[settingName].value});
            }
        }
        saveToSettingsPerWorkflow('inferenceSteps');
        saveToSettingsPerWorkflow('width');
        saveToSettingsPerWorkflow('height');
        saveToSettingsPerWorkflow('resolution');
        saveToSettingsPerWorkflow('batchSize');
        saveToSettingsPerWorkflow('negativePrompt');
        saveToSettingsPerWorkflow('lora');
        saveToSettingsPerWorkflow('scheduler');
        saveToSettingsPerWorkflow('guidanceScale');
        saveToSettingsPerWorkflow('imageModel');
    });


    const imageUrls = ref<string[]>([]);
    const currentState = ref<SDGenerateState>("no_start");
    const stepText = ref("");
    const previewIdx = ref(0);
    const generateIdx = ref(-999);

    async function updateDestImage(index: number, image: string) {
        if (index + 1 > imageUrls.value.length) {
            imageUrls.value.push(image);
        } else {
            imageUrls.value.splice(index, 1, image);
        }
    }

    async function loadWorkflowsFromJson() {
        const workflowsFromFiles = await window.electronAPI.reloadImageWorkflows();
        const parsedWorkflows = workflowsFromFiles.map((workflow) => {
            try {
                return WorkflowSchema.parse(JSON.parse(workflow));
            } catch (error) {
                console.error('Failed to parse workflow', {error, workflow});
                return undefined;
            }
        }).filter((wf) => wf !== undefined);
        workflows.value = [...predefinedWorkflows, ...parsedWorkflows];
    }
    
    async function getMissingModels() {
        const checkList: CheckModelExistParam[] = [{ repo_id: imageModel.value, type: Const.MODEL_TYPE_STABLE_DIFFUSION }];
        if (lora.value !== "None") {
            checkList.push({ repo_id: lora.value, type: Const.MODEL_TYPE_LORA })
        }
        if (imagePreview.value) {
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
        return downloadList;
    }

    function generate() {
        generateIdx.value = 0;
        previewIdx.value = 0;
        stepText.value = i18nState.COM_GENERATING;
        if (activeWorkflow.value.backend === 'default') {
            stableDiffusion.generate();
        } else {
            comfyUi.generate();
        }
    }

    function stop() {
        if (activeWorkflow.value.backend === 'default') {
            stableDiffusion.stop();
        } else {
            comfyUi.stop();
        }
    }

    function reset() {
        currentState.value = "no_start";
        stableDiffusion.generateParams.length = 0;
        imageUrls.value.length = 0;
        generateIdx.value = -999;
        previewIdx.value = -1;
    }

    loadWorkflowsFromJson();

    return {
        backend,
        workflows,
        activeWorkflowName,
        activeWorkflow,
        processing,
        prompt,
        imageUrls,
        currentState,
        stepText,
        stopping,
        previewIdx,
        generateIdx,
        imageModel,
        lora,
        scheduler,
        guidanceScale,
        imagePreview,
        safeCheck,
        inferenceSteps,
        seed,
        width,
        height,
        batchSize,
        negativePrompt,
        settingsPerWorkflow,
        loadWorkflowsFromJson,
        getMissingModels,
        updateDestImage,
        generate,
        stop,
        reset
    }
}, {
    persist: {
        debug: true,
        pick: ['backend', 'activeWorkflowName', 'settingsPerWorkflow']
    }
});

const predefinedWorkflows: Workflow[] = [
    {
        name: 'Standard',
        backend: 'default',
        tags: ['sd1.5'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'Lykon/dreamshaper-8',
            inpaintModel: 'Lykon/dreamshaper-8-inpainting',
            width: 512,
            height: 512,
            guidanceScale: 7,
            inferenceSteps: 20,
            scheduler: "DPM++ SDE Karras"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'Standard - High Quality',
        backend: 'default',
        tags: ['sd1.5', 'hq'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'Lykon/dreamshaper-8',
            inpaintModel: 'Lykon/dreamshaper-8-inpainting',
            width: 512,
            height: 512,
            guidanceScale: 7,
            inferenceSteps: 50,
            scheduler: "DPM++ SDE Karras"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'Standard - Fast',
        backend: 'default',
        tags: ['sd1.5', 'fast'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'Lykon/dreamshaper-8',
            inpaintModel: 'Lykon/dreamshaper-8-inpainting',
            width: 512,
            height: 512,
            guidanceScale: 1,
            inferenceSteps: 6,
            scheduler: "LCM",
            lora: "latent-consistency/lcm-lora-sdv1-5"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
            'lora'
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'HD',
        backend: 'default',
        tags: ['sdxl', 'high-vram'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'RunDiffusion/Juggernaut-XL-v9',
            inpaintModel: 'RunDiffusion/Juggernaut-XL-v9',
            width: 1024,
            height: 1024,
            guidanceScale: 7,
            inferenceSteps: 20,
            scheduler: "DPM++ SDE",
            lora: "None"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'HD - High Quality',
        backend: 'default',
        tags: ['sdxl', 'high-vram', 'hq'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'RunDiffusion/Juggernaut-XL-v9',
            inpaintModel: 'RunDiffusion/Juggernaut-XL-v9',
            width: 1024,
            height: 1024,
            guidanceScale: 7,
            inferenceSteps: 50,
            scheduler: "DPM++ SDE",
            lora: "None"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'HD - Fast',
        backend: 'default',
        tags: ['sdxl', 'high-vram', 'fast'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
            imageModel: 'RunDiffusion/Juggernaut-XL-v9',
            inpaintModel: 'RunDiffusion/Juggernaut-XL-v9',
            width: 1024,
            height: 1024,
            guidanceScale: 1,
            inferenceSteps: 6,
            scheduler: "LCM",
            lora: "latent-consistency/lcm-lora-sdxl"
        },
        displayedSettings: [
            'imageModel',
            'inpaintModel',
            'guidanceScale',
            'inferenceSteps',
            'scheduler',
        ],
        modifiableSettings: [
            'resolution',
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
        ]
    },
    {
        name: 'Manual',
        backend: 'default',
        tags: ['sd1.5', 'sdxl'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        displayedSettings: [
        ],
        modifiableSettings: [
            'seed',
            'negativePrompt',
            'batchSize',
            'imagePreview',
            'safetyCheck',
            'width',
            'height',
            'imageModel',
            'inpaintModel',
            'inferenceSteps',
            'guidanceScale',
            'scheduler',
            'lora',
        ]
    },
]
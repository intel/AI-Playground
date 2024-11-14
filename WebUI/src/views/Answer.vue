<template>
    <div id="answerPanel" class="h-full flex flex-col pr-4 pb-4 relative bg-origin-padding ">
        <div class="flex flex-row flex-auto overflow-y-auto">
            <div id="chatHistoryPanel" :class="{ 'w-12': !isHistoryVisible, 'w-56': isHistoryVisible }"
                class="flex flex-shrink-0 flex-col justify-between overflow-y-auto bg-gradient-to-r from-[#05010fb4]/20 to-[#05010fb4]/70 transition-all">
                <div class="flex flex-col-reverse">
                    <div v-if="isHistoryVisible" v-for="(conversation, conversationKey) in conversations.conversationList" :key="conversationKey"
                        @click="() => conversations.activeKey = conversationKey" :title="conversation?.[0]?.title ?? 'New Conversation'"
                        class="flex justify-between items-center h-12 cursor-pointer text-gray-300 p-4 hover:bg-[#00c4fa]/50"
                        :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''">
                        <span class="w-40 whitespace-nowrap overflow-x-auto text-ellipsis">{{ conversation?.[0]?.title ?? 'New Conversation' }}</span>
                        <span v-if="!conversations.isNewConversation(conversationKey)" @click="() => conversations.deleteConversation(conversationKey)" class="svg-icon i-delete w-5 h-5"></span>
                    </div>
                    <div v-else v-for="(conversation, conversationKey) in conversations.conversationList" :inVisibleKey="conversationKey"
                        @click="() => conversations.activeKey = conversationKey" :title="conversation?.[0]?.title ?? 'New Conversation'"
                        class="flex justify-between items-center h-12 py-2 cursor-pointer hover:bg-[#00c4fa]/50"
                        :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''">
                        <svg v-if="conversations.isNewConversation(conversationKey)" class="m-auto h-8 w-8 text-gray-300"  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                        <svg v-else class="m-auto h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"/>
                        </svg>

                    </div>
                </div>
                <div class="flex justify-end">
                    <button @click="isHistoryVisible = !isHistoryVisible" class="m-2 flex text-white">
                        <img v-if="!isHistoryVisible" :class="iconSizeClass" src="@/assets/svg/expand.svg" class="w-8 h-8" />
                        <img v-else :class="iconSizeClass" src="@/assets/svg/collapse.svg" class="w-8 h-8" />
                    </button>
                </div>
            </div>
            <div id="chatPanel" class="p-4 chat-panel flex-auto flex flex-col gap-6 m-4 text-white overflow-y-scroll"
                :class="fontSizeClass">
                <template v-for="chat, i in conversations.activeConversation">
                    <div class="flex items-start gap-3">
                        <img :class="iconSizeClass" src="@/assets/svg/user-icon.svg" />
                        <div class="flex flex-col gap-3 max-w-3/4">
                            <p class="text-gray-300" :class="nameSizeClass">{{ languages.ANSWER_USER_NAME }}</p>
                            <div class="chat-content" v-html="util.processHTMLTag(chat.question)"></div>
                        </div>
                    </div>
                    <div class="flex items-start gap-3">
                        <img :class="iconSizeClass" src="@/assets/svg/ai-icon.svg" />
                        <div
                            class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words">
                            <p class="text-gray-300" :class="nameSizeClass">{{ languages.ANSWER_AI_NAME }}</p>
                            <div class="ai-answer chat-content" v-html="markdownParser.parseMarkdown(chat.answer)">
                            </div>
                            <div class="answer-tools flex gap-3 items-center text-gray-300">
                                <button class="flex items-end" :title="languages.COM_COPY" @click="copyText">
                                    <span class="svg-icon i-copy w-4 h-4"></span>
                                    <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
                                </button>
                                <button class="flex items-end" :title="languages.COM_REGENERATE"
                                    @click="() => regenerateLastResponse(conversations.activeKey)"
                                    v-if="i + 1 == conversations.activeConversation.length">
                                    <span class="svg-icon i-refresh w-4 h-4"></span>
                                    <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
                                </button>
                                <button class="flex items-end" :title="languages.COM_DELETE" @click="() => conversations.deleteItemFromConversation(conversations.activeKey, i)">
                                    <span class="svg-icon i-delete w-4 h-4"></span>
                                    <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </template>
                <div class="flex items-start gap-3" v-show="processing">
                    <img :class="iconSizeClass" src="@/assets/svg/user-icon.svg" />
                    <div class="flex flex-col gap-3 max-w-3/4">
                        <p class="text-gray-300" :class="nameSizeClass">{{ languages.ANSWER_USER_NAME }}</p>
                        <p v-html="textIn"></p>
                    </div>
                </div>
                <div class="flex items-start gap-3" v-show="processing">
                    <img :class="iconSizeClass" src="@/assets/svg/ai-icon.svg" />
                    <div class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4  text-wrap break-words">
                        <p class="text-gray-300" :class="nameSizeClass">{{ languages.ANSWER_AI_NAME }}</p>
                        <div v-if="!downloadModel.downloading && !loadingModel" class="ai-answer cursor-block break-all"
                            v-html="textOut">
                        </div>
                        <div v-else class="px-20 h-24 w-768px flex items-center justify-center">
                            <progress-bar v-if="downloadModel.downloading" :text="downloadModel.text"
                                :percent="downloadModel.percent" class="w-512px"></progress-bar>
                            <loading-bar v-else-if="loadingModel" :text="languages.COM_LOADING_MODEL"
                                class="w-512px"></loading-bar>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="pl-4 h-48 gap-3 flex-none flex items-center justify-center relative border-t border-color-spilter pt-4">
            <div class="flex flex-col gap-2 flex-auto h-full">
                <div class="flex items-center justify-between gap-5 text-white px-2">
                    <div class="flex items-center">
                        <drop-selector :array="models.llms" @change="changeLLMModel" class="w-96">
                            <template #selected>
                                <model-drop-down-item
                                    :model="models.llms.find((m) => m.name === globalSetup.modelSettings.llm_model)"></model-drop-down-item>
                            </template>
                            <template #list="slotItem">
                                <model-drop-down-item :model="slotItem.item"></model-drop-down-item>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-generate-add w-10 h-10 text-purple-500 ml-1.5" @click="addLLMModel"></button>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500 flex-none ml-1"
                            @animationend="removeRonate360" @click="refreshLLMModles"></button>
                        <!-- <button
                            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-6"
                            @click="() => conversations.clearConversation(conversations.activeKey)">
                            <span class="svg-icon i-clear w-4 h-4"></span>
                            <span>{{ languages.ANSWER_ERROR_CLEAR_SESSION }}</span>
                        </button> -->
                        <button
                            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-2"
                            @click="increaseFontSize" :disabled="isMaxSize"
                            :class="{ 'opacity-50 cursor-not-allowed': isMaxSize }">
                            <span class="svg-icon i-zoom-in w-4 h-4"></span>
                            <span>{{ languages.INCREASE_FONT_SIZE }}</span>
                        </button>
                        <button
                            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-2"
                            @click="decreaseFontSize" :disabled="isMinSize"
                            :class="{ 'opacity-50 cursor-not-allowed': isMinSize }">
                            <span class="svg-icon i-zoom-out w-4 h-4"></span>
                            <span>{{ languages.DECREASE_FONT_SIZE }}</span>
                        </button>
                    </div>
                    <div class="flex justify-center items-center gap-2">
                        <div class="v-checkbox flex-none" type="button" :disabled="processing">
                            <button v-show="!ragData.processEnable" class="v-checkbox-control flex-none"
                                :class="{ 'v-checkbox-checked': ragData.enable }" @click="toggleRag(!ragData.enable)">
                            </button>
                            <span v-show="ragData.processEnable" class="w-4 h-4 svg-icon i-loading flex-none"></span>
                            <label class="v-checkbox-label">{{ languages.ANSWER_RAG_ENABLE }}</label>
                        </div>
                        <button
                            class="flex items-center justify-center flex-none gap-2 border border-white rounded-md text-sm px-4 py-1"
                            @click="ragData.showUploader = true" :disabled="!ragData.enable || processing">
                            <span class="svg-icon i-upload w-4 h-4"></span>
                            <span>{{ languages.ANSWER_RAG_OPEN_DIALOG }}</span>
                        </button>
                        <drop-selector :array="globalSetup.models.embedding" @change="changeEmbeddingModel"
                            :disabled="ragData.enable || processing" class="w-96">
                            <template #selected>
                                <div class="flex gap-2 items-center overflow-hidden text-ellipsis">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ globalSetup.modelSettings.embedding }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center text-ellipsis" :title="slotItem.item">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span class="h-7 overflow-hidden">{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                    </div>
                </div>
                <textarea class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
                    :placeholder="languages.COM_LLM_PROMPT" v-model="question" @keydown="fastGenerate"></textarea>
            </div>
            <div class="flex flex-col items-center gap-2 self-stretch w-24 flex-none">
                <button class="gernate-btn self-stretch flex flex-col flex-auto" @click="newPromptGenerate"
                    v-show="!processing">
                    <span class="svg-icon i-generate-add w-8 h-8"></span>
                    <span>{{ languages.COM_GENERATE }}</span>
                </button>
                <button class="gernate-btn self-stretch flex flex-col flex-auto" @click="stopGenerate"
                    v-show="processing">
                    <span class="svg-icon w-7 h-7" :class="{ 'i-stop': !stopping, 'i-loading': stopping }"></span>
                    <span>{{ languages.COM_GENERATE }}</span>
                </button>
            </div>
            <rag v-if="ragData.showUploader" ref="ragPanel" @close="ragData.showUploader = false"></rag>
        </div>
        <teleport to="#answerPanel" v-if="showDowloadDlg">
            <download-dialog ref="downloadDigCompt"></download-dialog>
        </teleport>
        <teleport to="#answerPanel" v-if="showModelRequestDialog">
            <add-l-l-m-dialog ref="addLLMDialog" @add-model="checkModel"></add-l-l-m-dialog>
        </teleport>
    </div>

</template>
<script setup lang="ts">
import Rag from "../components/Rag.vue";
import ProgressBar from "../components/ProgressBar.vue";
import LoadingBar from "../components/LoadingBar.vue";
import DropSelector from "@/components/DropSelector.vue";
import DownloadDialog from "@/components/DownloadDialog.vue";
import AddLLMDialog from "@/components/AddLLMDialog.vue";
import ModelDropDownItem from "@/components/ModelDropDownItem.vue";
import { useI18N } from '@/assets/js/store/i18n';
import { toast } from '@/assets/js/toast';
import { util } from '@/assets/js/util';
import { SSEProcessor } from "@/assets/js/sseProcessor";
import { useGlobalSetup } from "@/assets/js/store/globalSetup";
import { Model, useModels } from "@/assets/js/store/models";
import { MarkdownParser } from "@/assets/js/markdownParser";
import "highlight.js/styles/github-dark.min.css";
import { Const } from "@/assets/js/const";
import { useConversations } from "@/assets/js/store/conversations";

const conversations = useConversations();
const models = useModels();
const globalSetup = useGlobalSetup();
const i18nState = useI18N().state
const question = ref("");
const processing = ref(false);
let textOutFinish = false;
let abortController = new AbortController();
const textOutQueue = new Array<string>();
const textIn = ref("");
const textOut = ref("");
let firstOutput = false;
const ragPanel = ref<InstanceType<typeof Rag>>();
const downloadModel = reactive({
    downloading: false,
    text: "",
    percent: 0
});
const loadingModel = ref(false);
let receiveOut = "";
let chatPanel: HTMLElement;
const markdownParser = new MarkdownParser(i18nState.COM_COPY);
const showDowloadDlg = ref(false);
const showModelRequestDialog = ref(false);
const ragData = reactive({
    enable: false,
    processEnable: false,
    showUploader: false,
});
const downloadDigCompt = ref<InstanceType<typeof DownloadDialog>>()
const addLLMDialog = ref<InstanceType<typeof AddLLMDialog>>()

const source = ref("");
const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
    (e: "showModelRequest", success?: () => void, fail?: () => void): void
}>();

let abortContooler: AbortController | null;
const stopping = ref(false);
const fontSizeIndex = ref(1); // sets default to text-sm

const fontSizes = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl', 'text-5xl', 'text-6xl', 'text-7xl', 'text-8xl', 'text-9xl'];
const iconSizes = ['size-[40px]', 'size-[42px]', 'size-[44px]', 'size-[46px]', 'size-[48px]', 'size-[50px]', 'size-[52px]', 'size-[54px]', 'size-[56px]', 'size-[58px]', 'size-[60px]', 'size-[62px]', 'size-[64px]'];
const fontSizeClass = computed(() => fontSizes[fontSizeIndex.value]);
const nameSizeClass = computed(() => fontSizes[Math.max(fontSizeIndex.value - 2, 0)]);
const iconSizeClass = computed(() => iconSizes[fontSizeIndex.value]);
const isMaxSize = computed(() => fontSizeIndex.value >= fontSizes.length - 1);
const isMinSize = computed(() => fontSizeIndex.value <= 0);
const isHistoryVisible = ref(false);

const increaseFontSize = () => {
    if (!isMaxSize.value) {
        fontSizeIndex.value++;
    }
};

const decreaseFontSize = () => {
    if (!isMinSize.value) {
        fontSizeIndex.value--;
    }
};


onMounted(async () => {
    chatPanel = document.getElementById("chatPanel")!;
})

function finishGenerate() {
    textOutFinish = true;
}

function dataProcess(line: string) {
    console.log(`[${util.dateFormat(new Date(), "hh:mm:ss:fff")}] LLM data: ${line}`);

    const dataJson = line.slice(5);
    const data = JSON.parse(dataJson) as LLMOutCallback;
    switch (data.type) {
        case "text_out":
            if (data.dtype == 1) {
                const text = (firstOutput ? data.value : data.value) //.replace(/<[^>]+>/g, "");
                textOutQueue.push(text);
                if (firstOutput) {
                    firstOutput = false;
                    simulatedInput();
                }
            } else {
                source.value = data.value;
            }
            break;
        case "download_model_progress":
            downloadModel.downloading = true;
            downloadModel.text = `${i18nState.COM_DOWNLOAD_MODEL} ${data.repo_id}\r\n${data.download_size}/${data.total_size} ${data.percent}% ${i18nState.COM_DOWNLOAD_SPEED}: ${data.speed}`;
            downloadModel.percent = data.percent;
            break;
        case "download_model_completed":
            downloadModel.downloading = false;
            break;
        case "load_model":
            loadingModel.value = data.event == "start";
            break;
        case "error":
            processing.value = false;
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

function scrollToBottom(smooth = true) {
    if (chatPanel.scrollHeight - chatPanel.scrollTop > chatPanel.clientHeight) {
        chatPanel.scroll({ top: chatPanel.scrollHeight - chatPanel.clientHeight, behavior: smooth ? "smooth" : "auto" });
    }
}

async function updateTitle(conversation: ChatItem[]) {
    const instruction = `Create me a short descriptive title for the following conversation in a maximum of 20 characters. Don't use unnecessary words like 'Conversation about': `;
    const prompt = `${instruction}\n\n\`\`\`${JSON.stringify(conversation.slice(0, 3).map((item) => ({ question: item.question, answer: item.answer })))}\`\`\``;
    console.log("prompt", prompt);
    const chatContext = [{ question: prompt , answer: "" }];
    const requestParams = {
        device: globalSetup.modelSettings.graphics,
        prompt: chatContext,
        enable_rag: false,
        model_repo_id: globalSetup.modelSettings.llm_model,
        print_metrics: false
    };
    const response = await fetch(`${ globalSetup.apiHost }/api/llm/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestParams),
        signal: abortController.signal
    });
    const reader = response.body!.getReader();
    const responses: LLMOutCallback[] = []
    const getResponse = (line: string) => {
        responses.push(JSON.parse(line.slice(5)))
    }

    await new SSEProcessor(reader, getResponse, finishGenerate).start(); // is finishGenerate needed here? Cannot use it because of void input

    const isTextCallback = (item: LLMOutCallback): item is LLMOutTextCallback => item.type == "text_out" && item.dtype == 1;
    const newTitle = responses.filter(isTextCallback).reduce((acc, item) => acc + item.value, "").replace(/"/g, '');
    conversation[0].title = newTitle;
}

async function simulatedInput() {
    while (textOutQueue.length > 0) {
        const newText = textOutQueue.shift()!;
        receiveOut += newText;
        // textOut.value = receiveOut;
        textOut.value = markdownParser.parseMarkdown(receiveOut);
        await nextTick();
        scrollToBottom();
    }
    if (!textOutFinish) {
        await util.delay(20);
        await simulatedInput();
    } else {
        conversations.addToActiveConversation({
            question: textIn.value,
            answer: ragData.enable && source.value != "" ? `${receiveOut}\r\n\r\n${i18nState.RAG_SOURCE}${source.value}` : receiveOut,
        });
        if (conversations.activeConversation.length <= 3) {
            console.log('Conversations is less than 4 items long, generating new title');
            updateTitle(conversations.activeConversation);
        }
        processing.value = false;
        textIn.value = "";
        textOut.value = "";
        nextTick(() => {
            chatPanel.querySelectorAll("copy-code").forEach((item) => {
                const el = item as HTMLElement;
                el.removeEventListener("click", copyCode);
                el.addEventListener("click", copyCode);
            });
            scrollToBottom(false)
        })
    }
}

function fastGenerate(e: KeyboardEvent) {
    if (e.code == "Enter") {
        if (e.ctrlKey || e.shiftKey || e.altKey) {
            question.value += "\n";
        } else {
            e.preventDefault();
            newPromptGenerate();
        }
    }
}

async function newPromptGenerate() {

    const newPrompt = question.value.trim();
    if (newPrompt == "") {
        toast.error(useI18N().state.ANSWER_ERROR_NOT_PROMPT);
        return;
    }
    try {
        await checkModel();
        const chatContext = JSON.parse(JSON.stringify(conversations.activeConversation));
        chatContext.push({ question: newPrompt, answer: "" });
        generate(chatContext);
        question.value = "";
    } catch {

    }

}

async function checkModel() {
  return new Promise<void>(async (resolve, reject) => {
        const checkList: CheckModelExistParam[] = [{ repo_id: globalSetup.modelSettings.llm_model, type: Const.MODEL_TYPE_LLM }];
        if (!(await globalSetup.checkModelExists(checkList))[0].exist) {
            emits(
                "showDownloadModelConfirm",
                checkList,
                resolve,
                reject
            );
        } else {
            resolve && resolve();
        }
    });
}



async function generate(chatContext: ChatItem[]) {
    if (processing.value || chatContext.length == 0) { return; }

    try {
        textIn.value = util.escape2Html(chatContext[chatContext.length - 1].question);
        textOut.value = "";
        receiveOut = "";
        firstOutput = true;
        textOutQueue.splice(0, textOutQueue.length);
        if (!abortController) {
            abortController = new AbortController();
        }
        textOutFinish = false;
        processing.value = true;
        nextTick(scrollToBottom);
        const requestParams = {
            device: globalSetup.modelSettings.graphics,
            prompt: chatContext,
            enable_rag: ragData.enable,
            model_repo_id: globalSetup.modelSettings.llm_model
        };
        const response = await fetch(`${globalSetup.apiHost}/api/llm/chat`, {
            method: "POST", headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestParams),
            signal: abortController.signal
        });
        const reader = response.body!.getReader();
        await new SSEProcessor(reader, dataProcess, finishGenerate).start();
    } finally {
        processing.value = false;
    }
}

async function stopGenerate() {
    if (processing.value && !stopping.value) {
        stopping.value = true;
        await fetch(`${globalSetup.apiHost}/api/llm/stopGenerate`);
        if (abortContooler) {
            abortContooler.abort();
            abortContooler = null;
        }
        processing.value = false;
        stopping.value = false;
    }
}

function copyText(e: Event) {
    const target = e.target as HTMLElement;
    if (target) {
        target
        util.copyText((target.parentElement!.parentElement!.previousElementSibling! as HTMLElement).innerText);
    }
}

function removeRonate360(ev: AnimationEvent) {
    const target = ev.target as HTMLElement;
    target.classList.remove("animate-ronate360");
}

function changeLLMModel(model: Model, _: number) {
    globalSetup.applyModelSettings({ llm_model: model.name });
}

async function addLLMModel() {
    return new Promise<void>(async (resolve, reject) => {
      emits("showModelRequest", resolve, reject);
    })

}

async function refreshLLMModles(e: Event) {
    const button = e.target as HTMLElement;
    button.classList.add("animate-ronate360");
    await models.refreshModels();
}

function regenerateLastResponse(conversationKey: string) {
    const item = conversations.conversationList[conversationKey].pop();
    if (!item) return;
    const prompt = item.question;
    const chatContext = [...toRaw(conversations.conversationList[conversationKey])];
    chatContext.push({ question: prompt, answer: "" });
    generate(chatContext);
}

function copyCode(e: MouseEvent) {
    let target: HTMLElement | null = e.target as HTMLElement;
    while (target && target != chatPanel) {
        target = target.parentElement;
        if (target && target.classList.contains("code-section")) {
            const codeHtmlEl = target.querySelector(".code-content>pre") as HTMLElement;
            if (codeHtmlEl) {
                util.copyText(codeHtmlEl.innerText);
                toast.success(i18nState.COM_COPY_SUCCESS_TIP);
                return;
            }
        }
    }
}

function changeEmbeddingModel(item: any, _: number) {
    globalSetup.applyModelSettings({ embedding: item as string });
}

async function toggleRag(value: boolean) {
    if (ragData.processEnable) {
        return;
    }
    ragData.processEnable = true;
    try {
        if (value) {
            var checkList = [{ repo_id: globalSetup.modelSettings.embedding, type: Const.MODEL_TYPE_EMBEDDING }];
            if (!(await globalSetup.checkModelExists(checkList))[0].exist) {
                emits("showDownloadModelConfirm",
                    checkList,
                    enableRag,
                    () => { ragData.processEnable = false; }
                );
            } else {
                await enableRag();
            }
        } else {
            await fetch(`${globalSetup.apiHost}/api/llm/disableRag`);
            ragData.enable = false;
        }
    } finally {
        ragData.processEnable = false;
    }
}

async function enableRag() {
    const formData = new FormData();
    formData.append("repo_id", globalSetup.modelSettings.embedding);
    formData.append("device", globalSetup.modelSettings.graphics);
    await fetch(`${globalSetup.apiHost}/api/llm/enableRag`,
        {
            method: "POST",
            body: formData,
        }
    );
    ragData.enable = true;
    ragData.processEnable = false;
}

defineExpose({
  checkModel
})

</script>
<template>
    <div id="answerPanel" class="h-full flex flex-col p-4 relative">
        <div id="chatPanel" class="chat-panel flex-auto flex flex-col h-0 gap-6 m-4 overflow-y-auto text-white text-sm">
            <template v-for="chat, i in chatHistories">
                <div class="flex items-start gap-3">
                    <img src="@/assets/svg/user-icon.svg" />
                    <div class="flex flex-col gap-3 max-w-3/4">
                        <p>{{ languages.ANSWER_USER_NAME }}</p>
                        <div class="chat-content" v-html="util.processHTMLTag(chat.question)"></div>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <img src="@/assets/svg/ai-icon.svg" />
                    <div class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words">
                        <p>{{ languages.ANSWER_AI_NAME }}</p>
                        <div class="ai-answer chat-content" v-html="markdownParser.parseMarkdown(chat.answer)"></div>
                        <div class="answer-tools flex gap-3 items-center text-gray-300">
                            <button class="flex items-end" :title="languages.COM_COPY" @click="copyText">
                                <span class="svg-icon i-copy w-4 h-4"></span>
                                <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
                            </button>
                            <button class="flex items-end" :title="languages.COM_REGENERATE"
                                @click="regenerate(chat, i)" v-if="i + 1 == chatHistories.length">
                                <span class="svg-icon i-refresh w-4 h-4"></span>
                                <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
                            </button>
                            <button class="flex items-end" :title="languages.COM_DELETE" @click="deleteChat(i)">
                                <span class="svg-icon i-delete w-4 h-4"></span>
                                <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </template>
            <div class="flex items-start gap-3" v-show="processing">
                <img src="@/assets/svg/user-icon.svg" />
                <div class="flex flex-col gap-3 max-w-3/4">
                    <p>{{ languages.ANSWER_USER_NAME }}</p>
                    <p v-html="textIn"></p>
                </div>
            </div>
            <div class="flex items-start gap-3" v-show="processing">
                <img src="@/assets/svg/ai-icon.svg" />
                <div class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4  text-wrap break-words">
                    <p>{{ languages.ANSWER_AI_NAME }}</p>
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
        <div class="h-48 gap-3 flex-none flex items-center justify-center relative border-t border-color-spilter pt-4">
            <div class="flex flex-col gap-2 flex-auto h-full">
                <div class="flex items-center justify-between gap-5 text-white px-2">
                    <div class="flex items-center">
                        <drop-selector :array="globalSetup.models.llm" @change="changeLLMModel" class="w-96">
                            <template #selected>
                                <div class="flex gap-2 items-center overflow-hidden text-ellipsis">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ globalSetup.modelSettings.llm_model }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center text-ellipsis" :title="slotItem.item">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span class="h-7 overflow-hidden">{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500 flex-none ml-1"
                            @animationend="removeRonate360" @click="refreshLLMModles"></button>
                        <button
                            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-6"
                            @click="clearSession">
                            <span class="svg-icon i-clear w-4 h-4"></span>
                            <span>{{ languages.ANSWER_ERROR_CLEAR_SESSION }}</span>
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
    </div>

</template>
<script setup lang="ts">
import Rag from "../components/Rag.vue";
import ProgressBar from "../components/ProgressBar.vue";
import LoadingBar from "../components/LoadingBar.vue";
import DropSelector from "@/components/DropSelector.vue";
import DownloadDialog from "@/components/DownloadDialog.vue";
import { useI18N } from '@/assets/js/store/i18n';
import { toast } from '@/assets/js/toast';
import { util } from '@/assets/js/util';
import { SSEProcessor } from "@/assets/js/sseProcessor";
import { useGlobalSetup } from "@/assets/js/store/globalSetup";
import { MarkdownParser } from "@/assets/js/markdownParser";
import "highlight.js/styles/github-dark.min.css";
import { Const } from "@/assets/js/const";

const globalSetup = useGlobalSetup();
const i18nState = useI18N().state
const question = ref("");
const processing = ref(false);
let textOutFinish = false;
const chatHistories = ref<ChatItem[]>([]);
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
const ragData = reactive({
    enable: false,
    processEnable: false,
    showUploader: false,
});
const downloadDigCompt = ref<InstanceType<typeof DownloadDialog>>()
const source = ref("");
const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
}>();
let abortContooler: AbortController | null;
const stopping = ref(false);

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
                const text = (firstOutput ? data.value : data.value).replace(/<[^>]+>/g, "");
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
        chatHistories.value.push({
            question: textIn.value,
            answer: ragData.enable && source.value != "" ? `${receiveOut}\r\n\r\n${i18nState.RAG_SOURCE}${source.value}` : receiveOut,
        });
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
        const chatContext = [...toRaw(chatHistories.value)];
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

function changeLLMModel(item: any, _: number) {
    globalSetup.applyModelSettings({ llm_model: item as string });
}

async function refreshLLMModles(e: Event) {
    const button = e.target as HTMLElement;
    button.classList.add("animate-ronate360");
    await globalSetup.refreshLLMModles();
}

async function clearSession() {
    chatHistories.value.splice(0, chatHistories.value.length);
}

function regenerate(item: ChatItem, index: number) {
    const prompt = item.question;
    chatHistories.value.splice(index, 1);
    const chatContext = [...toRaw(chatHistories.value)];
    chatContext.push({ question: prompt, answer: "" });
    generate(chatContext);
}

function deleteChat(index: number) {
    chatHistories.value.splice(index, 1);
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


</script>
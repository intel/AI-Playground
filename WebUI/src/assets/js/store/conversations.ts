import { defineStore } from "pinia";

export const useConversations = defineStore("conversations", () => {
    const conversationList = ref<Record<string, ChatItem[]>>({});
    const activeKey = ref('');
    const activeConversation = computed(() => conversationList.value[activeKey.value]);

    const addToActiveConversation = (item: ChatItem) => {
        const list = conversationList.value[activeKey.value];
        list.push(item);
        addNewConversationIfLatestIsNotEmpty(conversationList.value);
    }

    function deleteConversation(conversationKey: string) {
        delete conversationList.value[conversationKey];
    }

    function clearConversation(conversationKey: string) {
        conversationList.value[conversationKey] = [];
    }

    function deleteItemFromConversation(conversationKey: string, index: number) {
        conversationList.value[conversationKey].splice(index, 1);
    }

    const isNewConversation = (key: string) => conversationList.value[key].length === 0;

    watchEffect(() => {
        if (Object.keys(conversationList.value).includes(activeKey.value)) return;
        const latestConversationKey = Object.keys(conversationList.value).at(-1);
        if (!latestConversationKey) return;
        activeKey.value = latestConversationKey;
    })

    return {
        conversationList,
        activeKey,
        activeConversation,
        addToActiveConversation,
        deleteConversation,
        clearConversation,
        deleteItemFromConversation,
        isNewConversation
    };
}, {
    persist: {
        pick: ['conversationList'],
        afterHydrate: (ctx) => addNewConversationIfLatestIsNotEmpty(ctx.store.$state.conversationList)
    }
});

function addNewConversationIfLatestIsNotEmpty(list: Record<string, ChatItem[]>) {
    if (Object.values(list).at(-1)?.length !== 0) {
        list[new Date().getTime().toString()] = [];
    }
}
export const useGlobalLoadingStore = defineStore(
    "GlobalLoading",
    () => {
        const visible = ref(false);
        const text = ref("");
        let counter = 0;

        // 计数式：嵌套/并发调用可各自 show/hide，全关才消失。
        function show(message = "") {
            counter += 1;
            text.value = message;
            visible.value = true;
        }

        function hide() {
            counter = Math.max(0, counter - 1);

            if (counter === 0) {
                visible.value = false;
                text.value = "";
            }
        }

        return { visible, text, show, hide };
    },
);

// FOMOD 安装向导 store：逐 step 收集 plugin 选择，Promise 桥接 lib 层 FomodSelectionResolver。
import type { FomodConfig } from "@/lib/fomod-parser";

type FomodWizardResolver = (value: Set<string> | null) => void;

export const useFomodWizardStore = defineStore("FomodWizard", () => {
    const open = ref(false);
    const moduleName = ref("");
    const config = ref<FomodConfig | null>(null);
    const stepIndex = ref(0);
    // 已选 plugin 名集合（跨 step 累积）
    const selected = ref<Set<string>>(new Set());
    let resolver: FomodWizardResolver | null = null;

    const step = computed(() => config.value?.installSteps[stepIndex.value] ?? null);
    const isLastStep = computed(() => (config.value ? stepIndex.value >= config.value.installSteps.length - 1 : true));

    function isPluginSelected(name: string): boolean {
        return selected.value.has(name);
    }

    // 按 group.type 约束 toggles：SelectExactlyOne/SelectAtMostOne 同组单选，其余多选。
    function togglePlugin(groupType: string, groupPlugins: string[], name: string) {
        const next = new Set(selected.value);
        if (next.has(name)) {
            next.delete(name);
        } else {
            if (groupType === "SelectExactlyOne" || groupType === "SelectAtMostOne") {
                for (const peer of groupPlugins) next.delete(peer);
            }
            next.add(name);
        }
        selected.value = next;
    }

    // 当前 step 是否满足组约束（SelectExactlyOne/SelectAtLeastOne 每组至少选一个）
    const stepValid = computed(() => {
        const current = step.value;
        if (!current) return false;
        for (const group of current.groups) {
            if (group.type === "SelectExactlyOne" || group.type === "SelectAtLeastOne") {
                if (!group.plugins.some((p) => selected.value.has(p.name))) return false;
            }
        }
        return true;
    });

    function startWizard(nextConfig: FomodConfig): Promise<Set<string> | null> {
        // 旧向导未关先取消，避免 resolver 悬挂。
        resolver?.(null);
        config.value = nextConfig;
        moduleName.value = nextConfig.moduleName;
        stepIndex.value = 0;
        // 默认选中 Required plugin（必装免点）
        const defaults = new Set<string>();
        for (const installStep of nextConfig.installSteps) {
            for (const group of installStep.groups) {
                for (const plugin of group.plugins) {
                    if (plugin.pluginType === "Required") defaults.add(plugin.name);
                }
            }
        }
        // SelectExactlyOne 无默认时预选 Recommended/第一个 Optional，保证可直接下一步。
        for (const installStep of nextConfig.installSteps) {
            for (const group of installStep.groups) {
                if (group.type !== "SelectExactlyOne") continue;
                if (group.plugins.some((p) => defaults.has(p.name))) continue;
                const recommended = group.plugins.find((p) => p.pluginType === "Recommended") ?? group.plugins[0];
                if (recommended) defaults.add(recommended.name);
            }
        }
        selected.value = defaults;
        open.value = true;
        return new Promise<Set<string> | null>((resolve) => {
            resolver = resolve;
        });
    }

    function nextStep() {
        if (!isLastStep.value) stepIndex.value += 1;
    }

    function prevStep() {
        if (stepIndex.value > 0) stepIndex.value -= 1;
    }

    function confirmWizard() {
        const currentResolver = resolver;
        resolver = null;
        open.value = false;
        const result = new Set(selected.value);
        config.value = null;
        currentResolver?.(result);
    }

    function cancelWizard() {
        const currentResolver = resolver;
        resolver = null;
        open.value = false;
        config.value = null;
        currentResolver?.(null);
    }

    return {
        open,
        moduleName,
        step,
        stepIndex,
        isLastStep,
        selected,
        stepValid,
        isPluginSelected,
        togglePlugin,
        startWizard,
        nextStep,
        prevStep,
        confirmWizard,
        cancelWizard,
    };
});

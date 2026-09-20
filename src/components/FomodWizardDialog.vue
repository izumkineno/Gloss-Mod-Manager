<script setup lang="ts">
// FOMOD 安装向导：逐 installStep 展示 group/plugin，组约束单选/多选，确认后汇总选择。
const wizard = useFomodWizardStore();
const { open, moduleName, step, stepIndex, isLastStep, stepValid } = storeToRefs(wizard);

function groupHint(type: string): string {
    switch (type) {
        case "SelectExactlyOne":
            return "单选";
        case "SelectAtMostOne":
            return "至多选一个";
        case "SelectAtLeastOne":
            return "至少选一个";
        case "SelectAll":
            return "全选";
        default:
            return "多选";
    }
}

function pluginBadge(type: string): string {
    switch (type) {
        case "Required":
            return "必装";
        case "Recommended":
            return "推荐";
        case "Optional":
            return "可选";
        default:
            return "不可用";
    }
}
</script>

<template>
    <Dialog v-model:open="open" modal>
        <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl" @escape-key-down="wizard.cancelWizard" @pointer-down-outside="wizard.cancelWizard">
            <DialogHeader>
                <DialogTitle>{{ moduleName || "FOMOD 安装向导" }}</DialogTitle>
                <DialogDescription>
                    {{ step?.name ?? "" }}
                </DialogDescription>
            </DialogHeader>
            <div v-if="step" class="space-y-4">
                <div v-for="group in step.groups" :key="group.name" class="space-y-2 rounded-xl border px-3 py-2">
                    <div class="flex items-center justify-between">
                        <div class="text-sm font-medium">{{ group.name }}</div>
                        <Badge variant="outline">{{ groupHint(group.type) }}</Badge>
                    </div>
                    <label
                        v-for="plugin in group.plugins"
                        :key="plugin.name"
                        class="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
                        :class="{ 'opacity-50': plugin.pluginType === 'NotUsable' || plugin.pluginType === 'CouldBeUsable' }"
                    >
                        <input
                            type="checkbox"
                            class="mt-1 h-4 w-4 shrink-0 accent-primary"
                            :checked="wizard.isPluginSelected(plugin.name)"
                            :disabled="plugin.pluginType === 'NotUsable' || plugin.pluginType === 'CouldBeUsable'"
                            @change="wizard.togglePlugin(group.type, group.plugins.map((p) => p.name), plugin.name)"
                        />
                        <span class="min-w-0 flex-1">
                            <span class="flex flex-wrap items-center gap-2">
                                <span class="text-sm font-medium">{{ plugin.name }}</span>
                                <Badge variant="outline" class="text-xs">{{ pluginBadge(plugin.pluginType) }}</Badge>
                            </span>
                            <span v-if="plugin.description" class="mt-0.5 line-clamp-3 block text-xs text-muted-foreground">{{ plugin.description }}</span>
                        </span>
                    </label>
                </div>
            </div>
            <DialogFooter class="flex items-center justify-between gap-2">
                <div class="text-xs text-muted-foreground">第 {{ stepIndex + 1 }} 步</div>
                <div class="flex gap-2">
                    <Button v-if="stepIndex > 0" size="sm" variant="outline" @click="wizard.prevStep">上一步</Button>
                    <Button size="sm" variant="outline" @click="wizard.cancelWizard">取消</Button>
                    <Button v-if="!isLastStep" size="sm" :disabled="!stepValid" @click="wizard.nextStep">下一步</Button>
                    <Button v-else size="sm" :disabled="!stepValid" @click="wizard.confirmWizard">安装所选</Button>
                </div>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

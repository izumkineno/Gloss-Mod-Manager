<!-- 当前游戏徽标：管理页 / 游览页共用 -->
<script setup lang="ts">
import { Gamepad2 } from "lucide-vue-next";

const manager = useManager();

// 当前游戏显示名，无选择时为空
const gameName = computed(() => {
    const game = manager.managerGame;
    return game ? game.gameShowName || game.gameName : "";
});
</script>

<template>
    <Badge variant="secondary" class="gap-1.5 px-2.5 py-1 text-xs font-normal">
        <Gamepad2 class="size-3.5 text-primary" />
        <span class="text-muted-foreground">当前游戏</span>
        <span v-if="gameName" class="font-medium text-foreground">{{
            $t(gameName)
        }}</span>
        <span v-else class="text-muted-foreground/70">未选择</span>
    </Badge>
</template>

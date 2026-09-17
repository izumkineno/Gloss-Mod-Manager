<script setup lang="ts">
import { join } from "@tauri-apps/api/path";
import { ElMessage } from "element-plus-message";
import { useI18n } from "vue-i18n";

const manager = useManager();
const router = useRouter();
const { t } = useI18n();

function select(item: ISupportedGames) {
    const resolvedGame =
        manager.supportedGames.find((game) => {
            return game.GlossGameId === item.GlossGameId;
        }) ??
        manager.supportedGames.find((game) => {
            return game.gameName === item.gameName;
        }) ??
        item;

    manager.managerGame = {
        ...resolvedGame,
        ...item,
    };

    router.push({ name: "/manager" });
}

function openGameFolder(item: ISupportedGames) {
    console.log(item);

    if (item.gamePath) {
        FileHandler.openFolder(item.gamePath);
    } else {
        ElMessage.error(t("games.notFound"));
    }
}

async function openModFolder(item: ISupportedGames) {
    const storagePath = (await PersistentStore.get("storagePath", "")) || "";
    const modFolder = await join(storagePath, "mods", item.gameName);
    FileHandler.openFolder(modFolder);
}

const deleteTargetGame = ref<ISupportedGames | null>(null);
const showDeleteDialog = ref(false);

function requestDeleteGame(item: ISupportedGames) {
    deleteTargetGame.value = item;
    showDeleteDialog.value = true;
}

function confirmDeleteGame() {
    const target = deleteTargetGame.value;
    if (!target) return;
    manager.managerGameList = manager.managerGameList.filter(
        (game) => game.gameName !== target.gameName,
    );
    deleteTargetGame.value = null;
    showDeleteDialog.value = false;
}

// 右键菜单目标卡片
const contextTargetGame = ref<ISupportedGames | null>(null);

function handleCardContextmenu(item: ISupportedGames) {
    contextTargetGame.value = item;
}
</script>
<template>
    <Card>
        <CardHeader>
            <CardTitle class="flex flex-wrap items-center gap-4">
                {{ t("games.library") }}
                <div class="flex flex-wrap items-center gap-2">
                    <CustomGameDialog />
                </div>
            </CardTitle>
        </CardHeader>
        <ContextMenu>
            <ContextMenuTrigger as-child>
                <div
                    class="grid grid-cols-1 items-center gap-4 justify-items-center sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                >
            <div
                v-for="item in manager.managerGameList"
                :key="item.gameName"
                class="flex flex-col items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors hover:bg-accent/50"
                @contextmenu="handleCardContextmenu(item)"
            >
                <img
                    :src="item.gameCoverImg"
                    :alt="item.gameName"
                    @click="select(item)"
                    class="h-25 hover:bg-accent/50 cursor-pointer"
                />
                <div>{{ $t(item.gameName) }}</div>
                <div class="flex w-full items-center justify-between gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger>
                            <Button variant="outline" size="icon">
                                <IconMenu class="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                            <DropdownMenuItem @click="openGameFolder(item)"
                                >{{ t("games.openGameFolder") }}</DropdownMenuItem
                            >
                            <DropdownMenuItem @click="openModFolder(item)"
                                >{{ t("games.openModFolder") }}</DropdownMenuItem
                            >
                            <DropdownMenuItem @click="requestDeleteGame(item)"
                                >{{ t("common.delete") }}</DropdownMenuItem
                            >
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <StartGame :game="item" />
                </div>
            </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent v-if="contextTargetGame" class="w-48">
                <ContextMenuItem
                    @select="contextTargetGame && openGameFolder(contextTargetGame)"
                >
                    {{ t("games.openGameFolder") }}
                </ContextMenuItem>
                <ContextMenuItem
                    @select="contextTargetGame && openModFolder(contextTargetGame)"
                >
                    {{ t("games.openModFolder") }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    variant="destructive"
                    @select="contextTargetGame && requestDeleteGame(contextTargetGame)"
                >
                    {{ t("common.delete") }}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
        <AlertDialog v-model:open="showDeleteDialog">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>确认删除</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ deleteTargetGame?.gameName }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                        class="bg-destructive text-white hover:bg-destructive/90"
                        @click="confirmDeleteGame()"
                    >
                        {{ t("common.delete") }}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </Card>
</template>
<style scoped></style>

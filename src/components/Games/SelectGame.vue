<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { dirname, join } from "@tauri-apps/api/path";
import { ElMessage } from "element-plus-message";
import { ChevronDown, Gamepad2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

const manager = useManager();
const showSelectDialog = ref(false);
const searchKeyword = ref("");
const { t } = useI18n();

const filteredGames = computed(() => {
    const keyword = normalizeCompareText(searchKeyword.value);

    if (!keyword) {
        return manager.supportedGames;
    }

    return manager.supportedGames.filter((item) => {
        const matchedNames = [item.gameName, String(t(item.gameName))].map(
            (name) => normalizeCompareText(name),
        );

        return matchedNames.some((name) => name.includes(keyword));
    });
});

const gameCountLabel = computed(() => {
    const total = manager.supportedGames.length;

    if (!searchKeyword.value.trim()) {
        return t("games.totalCount", { total });
    }

    return t("games.matchedCount", {
        matched: filteredGames.value.length,
        total,
    });
});

async function select(item: ISupportedGames) {
    const path = await ScanGame.getSteamGamePath(
        item.steamAppID,
        item.installdir,
    );

    const selectGameByFolder = await PersistentStore.get(
        "selectGameByFolder",
        false,
    );
    const selected = await open({
        directory: selectGameByFolder,
        title: t("games.selectExecutableTitle", { exe: item.gameExe }),
        filters: [{ name: t("games.executableFilter"), extensions: ["exe"] }],
        defaultPath: path,
    });

    if (selected) {
        const folder = selectGameByFolder ? selected : await dirname(selected);
        const files = await FileHandler.getAllFilesInFolder(folder);

        if (typeof item.gameExe == "string") {
            // 判断 item.gameExe 是否存在于 files 中
            if (files.includes(item.gameExe)) {
                manager.managerGame = {
                    ...item,
                    gamePath: folder,
                };
            } else {
                ElMessage.error(
                    t("games.selectFolderError", { exe: item.gameExe }),
                );
                return;
            }
        } else {
            // 判断 item.gameExe 是否存在于 files 中
            let exe = item.gameExe.find((item) => files.includes(item.name));
            if (exe) {
                manager.managerGame = {
                    ...item,
                    gamePath: await join(folder, ...exe.rootPath),
                };
                console.log({
                    gamePath: await join(folder, ...exe.rootPath),
                    exeRootPath: exe.rootPath,
                });
            } else {
                let exename = item.gameExe
                    .map((item) => item.name)
                    .join(` ${t("common.or")} `);
                ElMessage.error(
                    t("games.selectFolderError", { exe: exename }),
                );
                return;
            }
        }

        AppAnalytics.sendEvent(`switch_game`, item.gameName);

        const game = manager.managerGameList.find(
            (g) => g.gameName === item.gameName,
        );

        if (game) {
            manager.managerGameList = manager.managerGameList.map((g) => {
                if (g.gameName === item.gameName && manager.managerGame) {
                    return manager.managerGame;
                } else {
                    return g;
                }
            });
        } else {
            manager.managerGameList.push(manager.managerGame);
        }

        showSelectDialog.value = false;
    }
}
</script>
<template>
    <div class="select-game">
        <Dialog with-backdrop v-model:open="showSelectDialog">
            <DialogTrigger as-child>
                <button
                    type="button"
                    class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors hover:bg-accent/60"
                >
                    <img
                        v-if="manager.managerGame?.gameCoverImg"
                        :src="manager.managerGame.gameCoverImg"
                        :alt="manager.managerGame.gameName"
                        class="h-5 w-5 rounded object-cover"
                        draggable="false"
                    />
                    <Gamepad2 v-else class="size-3.5 text-muted-foreground" />
                    <span class="max-w-40 truncate leading-none">
                        {{
                            manager.managerGame
                                ? $t(manager.managerGame.gameName)
                                : t("games.selectGame")
                        }}
                    </span>
                    <ChevronDown class="size-3 shrink-0 text-muted-foreground" />
                </button>
            </DialogTrigger>
            <DialogContent class="w-225 max-w-[70%]!">
                <DialogHeader>
                    <DialogTitle class="flex gap-3">
                        <div class="flex items-center">
                            {{ t("games.selectGame") }}
                            <small>({{ gameCountLabel }})</small>
                        </div>
                        <div class="flex-1 max-w-[75%]">
                            <InputGroup>
                                <InputGroupInput
                                    v-model="searchKeyword"
                                    :placeholder="t('games.searchGame')"
                                ></InputGroupInput>
                                <InputGroupAddon align="inline-end">
                                    <Button variant="ghost" size="icon">
                                        <IconSearch class="h-4 w-4" />
                                    </Button>
                                </InputGroupAddon>
                            </InputGroup>
                        </div>
                    </DialogTitle>
                </DialogHeader>
                <div
                    class="grid grid-cols-4 items-center gap-4 justify-items-center"
                >
                    <div
                        v-for="item in filteredGames"
                        :key="item.gameName"
                        @click="select(item)"
                        class="flex flex-col items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors hover:bg-accent/50 cursor-pointer"
                    >
                        <img
                            class="h-25"
                            :src="item.gameCoverImg"
                            :alt="item.gameName"
                        />
                        <div>{{ $t(item.gameName) }}</div>
                    </div>
                    <div
                        v-if="!filteredGames.length"
                        class="col-span-4 py-10 text-center text-sm text-muted-foreground"
                    >
                        {{ t("games.noMatches") }}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    </div>
</template>
<style scoped></style>

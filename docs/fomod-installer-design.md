# FOMOD 解析驱动设计

> 参考：`docs/fomod-ModuleConfig.xsd`（ModuleConfig XSD 原文，692 行）
> 规范：https://fomod-docs.readthedocs.io/en/latest/specs.html
> 状态：设计稿，未实现

## 1. 目标

安装时检测压缩包内 `fomod/ModuleConfig.xml`，按 `installSteps` 向用户展示选项向导，
收集选中 plugin 的 `<files>` 映射后拷贝到游戏目录。不支持 FOMOD 时回退现有逻辑（整包解压）。

## 2. 数据模型（对齐 XSD）

```ts
interface FomodFileMapping { source: string; destination?: string; alwaysInstall?: boolean; installIfUsable?: boolean; priority?: number }
interface FomodPlugin { name: string; description: string; image?: string; files: FomodFileMapping[]; conditionFlags: { name: string; value: string }[]; type: "Required" | "Optional" | "Recommended" | "NotUsable" | "CouldBeUsable" }
type FomodGroupType = "SelectAtLeastOne" | "SelectAtMostOne" | "SelectExactlyOne" | "SelectAll" | "SelectAny";
interface FomodGroup { name: string; type: FomodGroupType; plugins: FomodPlugin[] }
interface FomodStep { name: string; visible?: CompositeDependency; groups: FomodGroup[] }
interface FomodConfig { moduleName: string; moduleImage?: string; requiredInstallFiles: FomodFileMapping[]; installSteps: FomodStep[]; conditionalFileInstalls: { dependencies: CompositeDependency; files: FomodFileMapping[] }[] }
```

依赖求值：`compositeDependency(operator=And|Or)` 递归求值，叶子为
`fileDependency(file+state)` / `flagDependency(flag+value)` /
`gameDependency(version)` / `fommDependency(version)`。
GMM 无插件激活概念：`fileDependency` 按“文件是否已安装到目标目录”判定 Active/Missing 即可。

## 3. 解析（XML → FomodConfig）

- 前端已有 XML 解析需求但无依赖：用 `DOMParser`（浏览器/Tauri WebView 原生可用），零依赖。
- 大小写注意：包内目录可能是 `fomod/` 或 `FOMOD/`，不区分大小写查找 `ModuleConfig.xml`。
- 图片路径 `fomod/xxx.jpg` 为包内相对路径，用 `blob:` 预览。

## 4. 安装流程

```
解压到临时目录 → 探测 fomod/ModuleConfig.xml
  → 无：走现有整包安装
  → 有：解析 → requiredInstallFiles 直接装 → 逐 step 弹窗（按 group.type 约束单选/多选）
       → 汇总选中 plugin.files（按 priority 排序，后者覆盖前者）
       → conditionalFileInstalls 按 flag 求值追加 → 拷贝 source→destination
```

- `destination` 省略时等于 `source`（相对游戏 Mod 目录）。
- `alwaysInstall` 文件无论 plugin 是否选中都装。
- Cyberpunk 2077 无 ESP 概念：`plugin` 在此仅表示“可选项”，勿与 Bethesda 插件混淆。

## 5. UI

复用 shadcn-vue Dialog + RadioGroup（SelectExactlyOne/SelectAtMostOne）/ Checkbox（其余）。
每步一页，显示 plugin.description + image 预览，NotUsable 置灰并标注原因。

## 6. 测试用例

NCR Music Collection（原 `D:/Games/GMM/mods/Cyberpunk 2077/489`，已不在磁盘）：
单 step、单组 8 个 `music_track_*` 互斥选项（SelectExactlyOne），最简场景，适合做首个回归包。

## 7. 范围外

C# 脚本安装器（`fomod/*.cs` script 类型，非 XML）暂不支持，检测到时提示用户用 Vortex/MO2。

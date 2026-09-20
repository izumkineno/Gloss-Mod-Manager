// FOMOD ModuleConfig.xml 解析器（零依赖，DOMParser）。
// 参考 docs/fomod-ModuleConfig.xsd / docs/fomod-installer-design.md

export interface FomodFileMapping {
  /** 包内源路径 */
  source: string;
  /** 安装目标路径（省略时等于 source） */
  destination: string;
  alwaysInstall: boolean;
  installIfUsable: boolean;
  priority: number;
  /** file | folder */
  kind: "file" | "folder";
}

export interface FomodConditionFlag {
  name: string;
  value: string;
}

export type FomodPluginType =
  | "Required"
  | "Optional"
  | "Recommended"
  | "NotUsable"
  | "CouldBeUsable";

export interface FomodPlugin {
  name: string;
  description: string;
  image?: string;
  files: FomodFileMapping[];
  conditionFlags: FomodConditionFlag[];
  pluginType: FomodPluginType;
}

export type FomodGroupType =
  | "SelectAtLeastOne"
  | "SelectAtMostOne"
  | "SelectExactlyOne"
  | "SelectAll"
  | "SelectAny";

export interface FomodGroup {
  name: string;
  type: FomodGroupType;
  plugins: FomodPlugin[];
}

export type FomodDependencyOperator = "And" | "Or";

export interface FomodDependency {
  fileDependencies: { file: string; state: string }[];
  flagDependencies: { flag: string; value: string }[];
  gameDependency?: string;
  fommDependency?: string;
  children: FomodDependency[];
  operator: FomodDependencyOperator;
}

export interface FomodStep {
  name: string;
  visible?: FomodDependency;
  groups: FomodGroup[];
}

export interface FomodConditionalInstall {
  dependencies: FomodDependency;
  files: FomodFileMapping[];
}

export interface FomodConfig {
  moduleName: string;
  moduleImage?: string;
  requiredInstallFiles: FomodFileMapping[];
  installSteps: FomodStep[];
  conditionalFileInstalls: FomodConditionalInstall[];
}

// 中文注释：取直属子元素（忽略嵌套同名元素）
function childElements(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const child of el.children) {
    if (child.tagName === tag) out.push(child);
  }
  return out;
}

// 中文注释：解析 <files> 下的 file/folder 列表
function parseFileList(filesEl: Element | undefined): FomodFileMapping[] {
  if (!filesEl) return [];
  const out: FomodFileMapping[] = [];
  for (const child of filesEl.children) {
    if (child.tagName !== "file" && child.tagName !== "folder") continue;
    const source = child.getAttribute("source")?.trim() ?? "";
    if (!source) continue;
    out.push({
      source,
      destination: child.getAttribute("destination")?.trim() || source,
      alwaysInstall: child.getAttribute("alwaysInstall") === "true",
      installIfUsable: child.getAttribute("installIfUsable") === "true",
      priority: Number(child.getAttribute("priority") ?? 0) || 0,
      kind: child.tagName as "file" | "folder",
    });
  }
  return out;
}

// 中文注释：解析 <conditionFlags> 下的 flag 列表
function parseConditionFlags(el: Element): FomodConditionFlag[] {
  const list = childElements(el, "conditionFlags")[0];
  if (!list) return [];
  return childElements(list, "flag").map((f) => ({
    name: f.getAttribute("name")?.trim() ?? "",
    value: f.textContent?.trim() ?? "",
  }));
}

// 中文注释：解析 typeDescriptor（静态 type 或 dependencyType）
function parsePluginType(el: Element): FomodPluginType {
  const desc = childElements(el, "typeDescriptor")[0];
  if (!desc) return "Optional";
  const typeEl = childElements(desc, "type")[0];
  if (typeEl) {
    return (typeEl.getAttribute("name") as FomodPluginType) || "Optional";
  }
  // dependencyType：运行时按 patterns 求值，此处只取 defaultType
  const depType = childElements(desc, "dependencyType")[0];
  const defaultType = depType ? childElements(depType, "defaultType")[0] : undefined;
  return (defaultType?.getAttribute("name") as FomodPluginType) || "Optional";
}

// 中文注释：解析单个 plugin
function parsePlugin(el: Element): FomodPlugin | null {
  const name = el.getAttribute("name")?.trim();
  if (!name) return null;
  return {
    name,
    description: childElements(el, "description")[0]?.textContent?.trim() ?? "",
    image: childElements(el, "image")[0]?.getAttribute("path") ?? undefined,
    files: parseFileList(childElements(el, "files")[0]),
    conditionFlags: parseConditionFlags(el),
    pluginType: parsePluginType(el),
  };
}

// 中文注释：解析 dependencies（compositeDependency 递归）
function parseDependencies(el: Element): FomodDependency {
  const dep: FomodDependency = {
    fileDependencies: [],
    flagDependencies: [],
    children: [],
    operator: (el.getAttribute("operator") as FomodDependencyOperator) || "And",
  };
  for (const child of el.children) {
    if (child.tagName === "fileDependency") {
      dep.fileDependencies.push({
        file: child.getAttribute("file")?.trim() ?? "",
        state: child.getAttribute("state")?.trim() ?? "",
      });
    } else if (child.tagName === "flagDependency") {
      dep.flagDependencies.push({
        flag: child.getAttribute("flag")?.trim() ?? "",
        value: child.getAttribute("value")?.trim() ?? "",
      });
    } else if (child.tagName === "gameDependency") {
      dep.gameDependency = child.getAttribute("version") ?? undefined;
    } else if (child.tagName === "fommDependency") {
      dep.fommDependency = child.getAttribute("version") ?? undefined;
    } else if (child.tagName === "dependencies") {
      dep.children.push(parseDependencies(child));
    }
  }
  return dep;
}

// 中文注释：解析单个 installStep
function parseStep(el: Element): FomodStep {
  const groups: FomodGroup[] = [];
  const groupList = childElements(el, "optionalFileGroups")[0];
  if (groupList) {
    for (const g of childElements(groupList, "group")) {
      const plugins: FomodPlugin[] = [];
      const pluginList = childElements(g, "plugins")[0];
      if (pluginList) {
        for (const p of childElements(pluginList, "plugin")) {
          const plugin = parsePlugin(p);
          if (plugin) plugins.push(plugin);
        }
      }
      groups.push({
        name: g.getAttribute("name")?.trim() ?? "",
        type: (g.getAttribute("type") as FomodGroupType) || "SelectAny",
        plugins,
      });
    }
  }
  const visibleEl = childElements(el, "visible")[0];
  return {
    name: el.getAttribute("name")?.trim() ?? "",
    visible: visibleEl ? parseDependencies(visibleEl) : undefined,
    groups,
  };
}

// 中文注释：解析 ModuleConfig.xml 全文 → FomodConfig；失败抛错
export function parseFomodConfig(xml: string): FomodConfig {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error(`ModuleConfig.xml 解析失败：${parserError.textContent?.trim() ?? "未知错误"}`);
  }
  const config = doc.querySelector("config");
  if (!config) throw new Error("ModuleConfig.xml 缺少 <config> 根节点");

  const steps: FomodStep[] = [];
  const stepList = childElements(config, "installSteps")[0];
  if (stepList) {
    for (const s of childElements(stepList, "installStep")) {
      steps.push(parseStep(s));
    }
  }

  const conditionalFileInstalls: FomodConditionalInstall[] = [];
  const condList = childElements(config, "conditionalFileInstalls")[0];
  if (condList) {
    const patterns = childElements(condList, "patterns")[0];
    if (patterns) {
      for (const p of childElements(patterns, "pattern")) {
        const deps = childElements(p, "dependencies")[0];
        const files = childElements(p, "files")[0];
        if (!deps || !files) continue;
        conditionalFileInstalls.push({
          dependencies: parseDependencies(deps),
          files: parseFileList(files),
        });
      }
    }
  }

  const moduleImageEl = childElements(config, "moduleImage")[0];
  return {
    moduleName: childElements(config, "moduleName")[0]?.textContent?.trim() ?? "",
    moduleImage: moduleImageEl?.getAttribute("path") ?? undefined,
    requiredInstallFiles: parseFileList(childElements(config, "requiredInstallFiles")[0]),
    installSteps: steps,
    conditionalFileInstalls,
  };
}

// 中文注释：求值单个依赖节点（flags 为当前已选 plugin 置起的 flag 表）
export function evaluateDependency(
  dep: FomodDependency,
  flags: Record<string, string>,
  isFileInstalled?: (file: string) => boolean,
): boolean {
  const results: boolean[] = [];
  for (const fd of dep.fileDependencies) {
    if (!isFileInstalled) {
      // 无安装状态回调时 Missing 视为满足，其余视为不满足
      results.push(fd.state === "Missing");
      continue;
    }
    const installed = isFileInstalled(fd.file);
    results.push(
      fd.state === "Active" || fd.state === "Inactive" ? installed : !installed,
    );
  }
  for (const fd of dep.flagDependencies) {
    results.push(flags[fd.flag] === fd.value);
  }
  // game/fomm 版本依赖：GMM 不校验，视为满足
  for (const child of dep.children) {
    results.push(evaluateDependency(child, flags, isFileInstalled));
  }
  if (results.length === 0) return true;
  return dep.operator === "Or" ? results.some(Boolean) : results.every(Boolean);
}

// 中文注释：按用户选择汇总最终安装文件（required + 选中 plugin.files + 命中的 conditional）
export function resolveFomodInstallFiles(
  config: FomodConfig,
  selectedPlugins: Set<string>,
  flags: Record<string, string>,
  isFileInstalled?: (file: string) => boolean,
): FomodFileMapping[] {
  const collected: FomodFileMapping[] = [...config.requiredInstallFiles];
  for (const step of config.installSteps) {
    for (const group of step.groups) {
      for (const plugin of group.plugins) {
        if (!selectedPlugins.has(plugin.name)) continue;
        collected.push(...plugin.files);
      }
    }
  }
  for (const cond of config.conditionalFileInstalls) {
    if (evaluateDependency(cond.dependencies, flags, isFileInstalled)) {
      collected.push(...cond.files);
    }
  }
  // 按 priority 升序：高优先级后装（覆盖低优先级同目标文件）
  return collected.sort((a, b) => a.priority - b.priority);
}
// 中文注释：FOMOD 安装向导选择回调（lib 层不碰 UI，由调用方注入弹窗；返回 null = 用户取消）
export type FomodSelectionResolver = (config: FomodConfig) => Promise<Set<string> | null>;

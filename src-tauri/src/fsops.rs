//! P0 后端化：前端文件系统热点下沉（目录遍历 / 流式哈希）。
//!
//! 约定（沿用 downloader.rs 风格）：
//! - 错误一律 `Result<_, String>`，中文短句无结尾标点；
//! - 对前端快照结构一律 `#[serde(rename_all = "camelCase")]`；
//! - 无共享 State，全部无状态纯函数命令。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

/// walk 条目：`rel` 恒用 `/` 分隔的相对路径（`\\` 归一），顺序为 readdir 序（不排序）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    rel: String,
    size: u64,
    is_dir: bool,
    is_symlink: bool,
}

/// 递归枚举：对齐 `FileHandler.getAllFilesInFolder` 语义。
///
/// - `dir` 不存在 → `Ok(vec![])`（对齐前端 `!fileExists → return []`）；
/// - `recursive=false` 时只取顶层；`include_dirs=false` 时跳过目录与 symlink 条目
///   （对齐前端 symlink 丢弃分支）；
/// - 不跟随 symlink（`follow_links(false)`），防止链接环。
#[tauri::command]
pub fn fs_walk(dir: String, recursive: bool, include_dirs: bool) -> Result<Vec<WalkEntry>, String> {
    let root = PathBuf::from(&dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }

    let max_depth = if recursive { usize::MAX } else { 1 };
    let walker = walkdir::WalkDir::new(&root)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter();

    let mut out = Vec::new();
    for entry in walker {
        let entry = entry.map_err(|error| format!("遍历目录失败：{error}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let file_type = entry.file_type();
        let is_symlink = file_type.is_symlink();
        // symlink 视为非目录；是否跟随由调用方决定，前端枚举一律丢弃（见 FileHandler 侧过滤）
        let is_dir = file_type.is_dir();
        if is_dir && !include_dirs {
            continue;
        }
        if is_symlink && !include_dirs {
            // 对齐前端：两 flag 皆 false 时 symlink 直接丢弃
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&root)
            .map_err(|error| format!("遍历目录失败：{error}"))?;
        let rel = normalize_rel(rel);
        let size = if is_dir || is_symlink {
            0
        } else {
            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        out.push(WalkEntry {
            rel,
            size,
            is_dir,
            is_symlink,
        });
    }
    Ok(out)
}

/// 文件流式 MD5：64KB 分块，内存 O(1)，输出与 `js-md5` 一致的小写 hex。
#[tauri::command]
pub fn fs_file_hash(path: String) -> Result<String, String> {
    let file = File::open(&path).map_err(|_| format!("文件不存在：{path}"))?;
    let mut reader = BufReader::with_capacity(65536, file);
    let mut context = md5::Context::new();
    let mut buf = [0u8; 65536];
    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|error| format!("哈希计算失败：{error}"))?;
        if read == 0 {
            break;
        }
        context.consume(&buf[..read]);
    }
    Ok(format!("{:x}", context.compute()))
}

/// 字符串 MD5：供 `getFolderHMd5` 的“拼 hex 串再 md5”一步，避免大 hex 串往返前端。
#[tauri::command]
pub fn fs_hash_string(data: String) -> Result<String, String> {
    Ok(format!("{:x}", md5::compute(data.as_bytes())))
}

/// 相对路径归一：`\\` → `/`，拒绝 `..`（walk 输出天然无 `..`，此处为纵深防御）。
fn normalize_rel(rel: &Path) -> String {
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    parts.join("/")
}

/// 批量安装请求：TS 只做编排（目标计算、锚匹配、去重），本命令做执行。
/// 无跨文件回滚——对齐前端逐项记态语义，失败只记该项 `ok:false`。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBatch {
    batch_id: String,
    allowed_roots: Vec<String>,
    items: Vec<InstallItem>,
    link_fallback_copy: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallItem {
    /// 透传标识（前端填 modFiles 相对路径），原样返回
    file: String,
    /// 绝对路径（前端拼好，后端不拼路径，只做越界校验）
    src: String,
    /// 绝对路径
    dst: String,
    /// "copy" | "link" | "mkdir" | "write_text" | "remove"
    op: String,
    /// "gmmback" | "linkback" | "none"（两系后缀互不通用，照搬前端）
    backup: String,
    /// 仅 write_text 用
    content: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    file: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    batch_id: String,
    done: u32,
    total: u32,
}

/// 批量文件搬运：copy/link/mkdir/write_text/remove 五原语，对齐 FileHandler 备份语义。
///
/// - `.gmmback`（带点）：copy/remove 的文件备份与还原（对齐 copyFile/deleteFile）；
/// - `_back`（无点）：link/remove 的链接目标备份与回滚（对齐 createLink/removeLink）。
#[tauri::command]
pub async fn mod_install_batch(
    app: tauri::AppHandle,
    req: InstallBatch,
) -> Result<Vec<FileState>, String> {
    if req.items.is_empty() {
        return Err("安装批次为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_batch(&app, req))
        .await
        .map_err(|error| format!("安装批次失败：{error}"))?
}

fn run_batch(app: &tauri::AppHandle, req: InstallBatch) -> Result<Vec<FileState>, String> {
    use tauri::Emitter;

    let roots: Vec<String> = req.allowed_roots.iter().map(|root| lexical(root)).collect();
    let total = req.items.len() as u32;
    let mut states = Vec::with_capacity(req.items.len());
    let mut last_emit = std::time::Instant::now();
    // 首个事件让前端及时建进度条（done=0）
    let _ = app.emit(
        "mod-install-progress",
        InstallProgress {
            batch_id: req.batch_id.clone(),
            done: 0,
            total,
        },
    );
    for item in &req.items {
        let state = apply_item(item, &roots, req.link_fallback_copy);
        states.push(state);
        let done = states.len() as u32;
        if done == total || done % 10 == 0 || last_emit.elapsed().as_millis() >= 200 {
            let _ = app.emit(
                "mod-install-progress",
                InstallProgress {
                    batch_id: req.batch_id.clone(),
                    done,
                    total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    Ok(states)
}
fn lexical(path: &str) -> String {
    let flattened = path.replace('\\', "/");
    let mut parts = Vec::new();
    for part in flattened.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return String::new();
        }
        parts.push(part);
    }
    parts.join("/")
}

/// 越界校验：归一后必须以某条合法根为前缀（相等或 `根/` 开头）。
fn check_scope(path: &str, roots: &[String]) -> Result<(), String> {
    let normalized = lexical(path);
    if normalized.is_empty() {
        return Err(format!("路径越界：{path}"));
    }
    let scoped = roots
        .iter()
        .any(|root| !root.is_empty() && (normalized == *root || normalized.starts_with(&format!("{root}/"))));
    if scoped {
        Ok(())
    } else {
        Err(format!("路径越界：{path}"))
    }
}

fn apply_item(item: &InstallItem, roots: &[String], link_fallback_copy: bool) -> FileState {
    let fail = |message: String| FileState {
        file: item.file.clone(),
        ok: false,
        error: Some(message),
    };
    if let Err(message) = check_scope(&item.src, roots).and(check_scope(&item.dst, roots)) {
        return fail(message);
    }
    let result = match item.op.as_str() {
        "copy" => op_copy(item),
        "link" => op_link(item, link_fallback_copy),
        "mkdir" => op_mkdir(item),
        "write_text" => op_write_text(item),
        "remove" => op_remove(item),
        other => Err(format!("未知操作：{other}")),
    };
    match result {
        Ok(()) => FileState {
            file: item.file.clone(),
            ok: true,
            error: None,
        },
        Err(message) => fail(message),
    }
}

fn ensure_parent(dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

/// 对齐 FileHandler.copyFile：dst 存在则先拷到 `dst.gmmback`，再真拷贝。
fn op_copy(item: &InstallItem) -> Result<(), String> {
    let src = PathBuf::from(&item.src);
    let dst = PathBuf::from(&item.dst);
    if !src.is_file() {
        return Err(format!("文件不存在：{}", item.src));
    }
    ensure_parent(&dst).map_err(|error| format!("复制文件失败：{error}"))?;
    if item.backup == "gmmback" && dst.exists() {
        let back = PathBuf::from(format!("{}.gmmback", item.dst));
        std::fs::copy(&dst, &back).map_err(|error| format!("复制文件失败：{error}"))?;
    }
    std::fs::copy(&src, &dst).map_err(|error| format!("复制文件失败：{error}"))?;
    Ok(())
}

/// 对齐 FileHandler.createLink：建链（目录失败回退 Junction），`_back` 备份与回滚。
fn op_link(item: &InstallItem, fallback_copy: bool) -> Result<(), String> {
    let src = PathBuf::from(&item.src);
    let dst = PathBuf::from(&item.dst);
    let src_is_dir = src.is_dir();
    if !src.exists() {
        return Err(format!("文件不存在：{}", item.src));
    }
    ensure_parent(&dst).map_err(|error| format!("创建软连接失败：{error}"))?;
    if item.backup == "linkback" && dst.exists() {
        let back = PathBuf::from(format!("{}_back", item.dst));
        if back.exists() {
            remove_path(&back).map_err(|error| format!("创建软连接失败：{error}"))?;
        }
        std::fs::rename(&dst, &back).map_err(|error| format!("创建软连接失败：{error}"))?;
    }
    let linked = create_symlink(&src, &dst, src_is_dir);
    if linked.is_err() && src_is_dir {
        // 对齐前端 Junction 回退（仅目录）
        if junction::create(&src, &dst).is_ok() {
            return Ok(());
        }
    }
    if let Err(error) = linked {
        if fallback_copy {
            return copy_dir_or_file(&src, &dst, src_is_dir, &item.backup);
        }
        rollback_link(item);
        return Err(format!("创建软连接失败：{error}"));
    }
    Ok(())
}

#[cfg(windows)]
fn create_symlink(src: &Path, dst: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

#[cfg(not(windows))]
fn create_symlink(src: &Path, dst: &Path, _is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

/// 建链失败且 `dst_back` 存在而 dst 不存在 → 迁回（对齐 createLink 回滚条件）。
fn rollback_link(item: &InstallItem) {
    let dst = PathBuf::from(&item.dst);
    let back = PathBuf::from(format!("{}_back", item.dst));
    if item.backup == "linkback" && back.exists() && !dst.exists() {
        let _ = std::fs::rename(&back, &dst);
    }
}

/// link 退化拷贝（对齐 closeSoftLinks=true）：目录递归，文件单拷，沿用 backup 语义。
fn copy_dir_or_file(src: &Path, dst: &Path, src_is_dir: bool, backup: &str) -> Result<(), String> {
    if !src_is_dir {
        return op_copy(&InstallItem {
            file: String::new(),
            src: src.to_string_lossy().into_owned(),
            dst: dst.to_string_lossy().into_owned(),
            op: "copy".to_string(),
            backup: if backup == "gmmback" { "gmmback" } else { "none" }.to_string(),
            content: None,
        });
    }
    std::fs::create_dir_all(dst).map_err(|error| format!("复制文件失败：{error}"))?;
    let walker = walkdir::WalkDir::new(src).follow_links(false).into_iter();
    for entry in walker {
        let entry = entry.map_err(|error| format!("复制文件失败：{error}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let rel = entry.path().strip_prefix(src).map_err(|error| format!("复制文件失败：{error}"))?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| format!("复制文件失败：{error}"))?;
        } else if entry.file_type().is_file() {
            if backup == "gmmback" && target.exists() {
                let back = PathBuf::from(format!("{}.gmmback", target.to_string_lossy()));
                std::fs::copy(&target, &back).map_err(|error| format!("复制文件失败：{error}"))?;
            }
            std::fs::copy(entry.path(), &target).map_err(|error| format!("复制文件失败：{error}"))?;
        }
    }
    Ok(())
}

/// 只建目录（注意：勿用 ensureDirectoryExistence 语义，它还会建文件）。
fn op_mkdir(item: &InstallItem) -> Result<(), String> {
    std::fs::create_dir_all(&item.dst).map_err(|error| format!("创建目录失败：{error}"))?;
    Ok(())
}

/// 原子写：父目录 + 同目录 tmp 写后 rename（Enabled.txt / pakList 回填原语）。
fn op_write_text(item: &InstallItem) -> Result<(), String> {
    let dst = PathBuf::from(&item.dst);
    let content = item.content.as_deref().unwrap_or("");
    ensure_parent(&dst).map_err(|error| format!("写入文件失败：{error}"))?;
    let tmp = dst.with_extension("gmm-tmp");
    std::fs::write(&tmp, content).map_err(|error| format!("写入文件失败：{error}"))?;
    std::fs::rename(&tmp, &dst).map_err(|error| format!("写入文件失败：{error}"))?;
    Ok(())
}

/// 对齐 deleteFile/removeLink：删 dst；备份存在则迁回。
/// backup="gmmback" 看 `dst.gmmback`，backup="linkback" 看 `dst_back`。
fn op_remove(item: &InstallItem) -> Result<(), String> {
    let dst = PathBuf::from(&item.dst);
    if dst.exists() {
        remove_path(&dst).map_err(|error| format!("删除文件失败：{error}"))?;
    }
    let back = match item.backup.as_str() {
        "gmmback" => Some(PathBuf::from(format!("{}.gmmback", item.dst))),
        "linkback" => Some(PathBuf::from(format!("{}_back", item.dst))),
        _ => None,
    };
    if let Some(back) = back {
        if back.exists() {
            std::fs::rename(&back, &dst).map_err(|error| format!("删除文件失败：{error}"))?;
        }
    }
    Ok(())
}

/// 类型判定规则：规则内 OR，规则按序首个命中返回；无命中回 `default`（调用方传 99）。
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyRule {
    id: i32,
    any_of: Vec<Matcher>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matcher {
    /// "basename" | "ext" | "segment" | "segment_ci" | "contains" | "suffix"
    kind: String,
    value: String,
}
/// 纯同步匹配引擎（无 async 即无 async 谓词误用类 bug）。
///
/// 语义逐字对齐前端：
/// - `basename` ＝尾段大小写无关相等（对齐 compareFileName）；
/// - `ext` ＝尾段扩展名去点小写相等（对齐 getFileExtension：无点/首点/尾点皆不命中）；
/// - `segment` ＝任一路径段精确相等（对齐 installByFolder 锚切分与 Unreal Scripts 大小写敏感）；
/// - `segment_ci` ＝任一段小写相等（对齐 REEngine pathParts 小写）；
/// - `contains` ＝尾段小写子串（对齐 Unity plugins 判定）；
/// - `suffix` ＝整路径小写后缀。
#[tauri::command]
pub fn mod_classify(files: Vec<String>, rules: Vec<ClassifyRule>, default: i32) -> Result<i32, String> {
    for rule in &rules {
        let hit = files.iter().any(|file| {
            let normalized = file.replace('\\', "/");
            rule.any_of.iter().any(|matcher| classify_one(&normalized, matcher))
        });
        if hit {
            return Ok(rule.id);
        }
    }
    Ok(default)
}

fn tail_segment(normalized: &str) -> &str {
    normalized.rsplit('/').next().unwrap_or(normalized)
}

fn classify_one(normalized: &str, matcher: &Matcher) -> bool {
    match matcher.kind.as_str() {
        "basename" => tail_segment(normalized).to_lowercase() == matcher.value.to_lowercase(),
        "ext" => {
            let tail = tail_segment(normalized);
            match tail.rfind('.') {
                Some(index) if index > 0 && index < tail.len() - 1 => {
                    tail[index + 1..].to_lowercase() == matcher.value.to_lowercase()
                }
                _ => false,
            }
        }
        "segment" => normalized.split('/').any(|part| part == matcher.value),
        "segment_ci" => {
            let wanted = matcher.value.to_lowercase();
            normalized.split('/').any(|part| part.to_lowercase() == wanted)
        }
        "contains" => tail_segment(normalized).to_lowercase().contains(&matcher.value.to_lowercase()),
        "suffix" => normalized.to_lowercase().ends_with(&matcher.value.to_lowercase()),
        _ => false,
    }
}

/// 不跟随链接删除：symlink 本体删（目录链接不递归内容），目录递归，文件直删。
fn remove_path(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if junction::exists(path).unwrap_or(false) {
        // Junction：FSCTL_DELETE_REPARSE_POINT 只去标签不删目录（junction::delete 语义），
        // 删链必须用 RemoveDirectory（remove_dir），且绝不递归目标内容
        return std::fs::remove_dir(path);
    }
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || meta.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    }
}
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gmm-fsops-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("sub").join("b.bin"), vec![0u8; 100000]).unwrap();
        fs::write(dir.join("空.txt"), "unicode-name").unwrap();
        dir
    }

    #[test]
    fn stream_hash_equals_oneshot() {
        let dir = fixture_dir("hash");
        // 1MB 随机感文件：流式结果必须与一次性 md5 完全一致（js-md5 兼容性命脉）
        let big = dir.join("big.dat");
        let payload: Vec<u8> = (0..1_048_576).map(|i| (i % 251) as u8).collect();
        fs::write(&big, &payload).unwrap();
        let expected = format!("{:x}", md5::compute(&payload));
        assert_eq!(fs_file_hash(big.to_string_lossy().into_owned()).unwrap(), expected);
        assert!(fs_file_hash(dir.join("不存在.txt").to_string_lossy().into_owned()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_shapes_match_legacy() {
        let dir = fixture_dir("walk");
        let root = dir.to_string_lossy().into_owned();
        // 递归全量：3 文件，不含目录
        let all = fs_walk(root.clone(), true, false).unwrap();
        let mut rels: Vec<&str> = all.iter().map(|entry| entry.rel.as_str()).collect();
        rels.sort_unstable();
        assert_eq!(rels, vec!["a.txt", "sub/b.bin", "空.txt"]);
        assert!(all.iter().all(|entry| !entry.is_dir));
        // 非递归：顶层文件 + sub 目录本身被 include_dirs=false 滤掉
        let top = fs_walk(root.clone(), false, false).unwrap();
        let mut top_rels: Vec<&str> = top.iter().map(|entry| entry.rel.as_str()).collect();
        top_rels.sort_unstable();
        assert_eq!(top_rels, vec!["a.txt", "空.txt"]);
        // 目录项：include_dirs=true 时 sub 出现且 size 为 0
        let with_dirs = fs_walk(root.clone(), true, true).unwrap();
        let sub = with_dirs.iter().find(|entry| entry.rel == "sub").unwrap();
        assert!(sub.is_dir && sub.size == 0);
        // 不存在目录回空表（对齐 !fileExists → []）
        assert!(fs_walk(dir.join("nope").to_string_lossy().into_owned(), true, false).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_hash_composition_matches_legacy() {
        // 旧语义：sort() 默认排序逐文件 md5 hex 拼接后再 md5；此处锁定组合公式
        let dir = fixture_dir("folder");
        let root = dir.to_string_lossy().into_owned();
        let entries = fs_walk(root.clone(), true, false).unwrap();
        let mut paths: Vec<String> = entries
            .iter()
            .map(|entry| format!("{root}/{}", entry.rel))
            .collect();
        paths.sort();
        let mut combined = String::new();
        for path in &paths {
            combined.push_str(&fs_file_hash(path.clone()).unwrap());
        }
        let legacy = format!("{:x}", md5::compute(combined.as_bytes()));
        assert_eq!(fs_hash_string(combined).unwrap(), legacy);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use std::fs;

    fn batch_dir(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("gmm-batch-{name}"));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        (src, dst)
    }

    fn item(file: &str, src: &Path, dst: &Path, op: &str, backup: &str) -> InstallItem {
        InstallItem {
            file: file.to_string(),
            src: src.to_string_lossy().into_owned(),
            dst: dst.to_string_lossy().into_owned(),
            op: op.to_string(),
            backup: backup.to_string(),
            content: None,
        }
    }

    fn roots_for(src: &Path, dst: &Path) -> Vec<String> {
        // allowed_roots 取 src/dst 的公共父级（lexical 前缀校验用）
        let base = src.parent().unwrap().to_string_lossy().into_owned();
        let _ = dst;
        vec![lexical(&base)]
    }

    #[test]
    fn copy_backs_up_existing_target() {
        let (src, dst) = batch_dir("copy");
        fs::write(src.join("a.txt"), "new").unwrap();
        fs::write(dst.join("a.txt"), "old").unwrap();
        let roots = roots_for(&src, &dst);
        let state = apply_item(&item("a.txt", &src.join("a.txt"), &dst.join("a.txt"), "copy", "gmmback"), &roots, false);
        assert!(state.ok);
        // 目标被覆盖，旧内容进 .gmmback（对齐 copyFile）
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dst.join("a.txt.gmmback")).unwrap(), "old");
    }

    #[test]
    fn remove_restores_backup() {
        let (src, dst) = batch_dir("remove");
        fs::write(dst.join("a.txt"), "installed").unwrap();
        fs::write(dst.join("a.txt.gmmback"), "original").unwrap();
        let roots = roots_for(&src, &dst);
        // 对齐 deleteFile：删 dst + .gmmback 迁回
        let state = apply_item(&item("a.txt", &src.join("a.txt"), &dst.join("a.txt"), "remove", "gmmback"), &roots, false);
        assert!(state.ok);
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "original");
        assert!(!dst.join("a.txt.gmmback").exists());
    }

    #[test]
    fn link_and_remove_linkback_roundtrip() {
        let (src, dst) = batch_dir("link");
        fs::write(src.join("f.txt"), "x").unwrap();
        fs::create_dir_all(src.join("folder")).unwrap();
        fs::write(src.join("folder").join("inner.txt"), "y").unwrap();
        let roots = roots_for(&src, &dst);
        // 文件建链无特权（os error 1314）时按 fallback_copy 退化拷贝
        let state = apply_item(&item("f.txt", &src.join("f.txt"), &dst.join("f.txt"), "link", "linkback"), &roots, true);
        assert!(state.ok, "{:?}", state.error);
        assert_eq!(fs::read_to_string(dst.join("f.txt")).unwrap(), "x");
        // 目录建链：原生 symlink 无特权则走 Junction（免特权），内容可见
        let state = apply_item(&item("folder", &src.join("folder"), &dst.join("folder"), "link", "linkback"), &roots, false);
        assert!(state.ok, "{:?}", state.error);
        assert_eq!(fs::read_to_string(dst.join("folder").join("inner.txt")).unwrap(), "y");
        // remove + linkback：删链本体（不跟随，源目录内容保留），无 _back 则结束
        let state = apply_item(&item("folder", &src.join("folder"), &dst.join("folder"), "remove", "linkback"), &roots, false);
        assert!(state.ok, "{:?}", state.error);
        assert!(!dst.join("folder").exists());
        assert_eq!(fs::read_to_string(src.join("folder").join("inner.txt")).unwrap(), "y");
    }

    #[test]
    fn out_of_scope_item_fails_only_itself() {
        let (src, dst) = batch_dir("scope");
        fs::write(src.join("a.txt"), "x").unwrap();
        let roots = vec![lexical(&dst.to_string_lossy())];
        // src 在根外 → 该项 ok=false；本项校验覆盖 src 与 dst
        let state = apply_item(&item("a.txt", &src.join("a.txt"), &dst.join("a.txt"), "copy", "none"), &roots, false);
        assert!(!state.ok);
        assert!(state.error.unwrap().starts_with("路径越界"));
        // .. 穿越同样拒绝
        let evil = format!("{}/../evil.txt", dst.to_string_lossy());
        let state = apply_item(&item("e", &src.join("a.txt"), &PathBuf::from(evil), "copy", "none"), &roots, false);
        assert!(!state.ok);
    }

    #[test]
    fn write_text_is_atomic_and_creates_parent() {
        let (src, dst) = batch_dir("write");
        let roots = roots_for(&src, &dst);
        let target = dst.join("deep").join("Enabled.txt");
        let mut it = item("e", &src.join("a.txt"), &target, "write_text", "none");
        it.content = Some("hello".to_string());
        let state = apply_item(&it, &roots, false);
        assert!(state.ok);
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        assert!(!target.with_extension("gmm-tmp").exists());
    }

    #[test]
    fn missing_source_is_item_error() {
        let (src, dst) = batch_dir("missing");
        let roots = roots_for(&src, &dst);
        let state = apply_item(&item("m.txt", &src.join("m.txt"), &dst.join("m.txt"), "copy", "gmmback"), &roots, false);
        assert!(!state.ok);
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    fn rule(id: i32, matchers: &[(&str, &str)]) -> ClassifyRule {
        ClassifyRule {
            id,
            any_of: matchers
                .iter()
                .map(|(kind, value)| Matcher {
                    kind: kind.to_string(),
                    value: value.to_string(),
                })
                .collect(),
        }
    }

    fn files(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn unreal_priority_and_case() {
        // ue4ss > pak > mods > scripts；大小写混杂
        let rules = vec![
            rule(2, &[("basename", "ue4ss.dll"), ("basename", "dwmapi.dll"), ("basename", "xinput1_3.dll")]),
            rule(1, &[("ext", "pak")]),
            rule(3, &[("basename", "Enabled.txt")]),
            rule(5, &[("segment", "Scripts")]),
        ];
        assert_eq!(mod_classify(files(&["a/XINPUT1_3.DLL", "b/c.pak"]), rules.clone(), 99).unwrap(), 2);
        assert_eq!(mod_classify(files(&["b/C.PAK"]), rules.clone(), 99).unwrap(), 1);
        assert_eq!(mod_classify(files(&["x/enabled.txt"]), rules.clone(), 99).unwrap(), 3);
        assert_eq!(mod_classify(files(&["ue4ss/Mods/Scripts/a.lua"]), rules.clone(), 99).unwrap(), 5);
        // Scripts 大小写敏感：小写 scripts 不命中
        assert_eq!(mod_classify(files(&["ue4ss/mods/scripts/a.lua"]), rules.clone(), 99).unwrap(), 99);
        assert_eq!(mod_classify(files(&["readme.txt"]), rules.clone(), 99).unwrap(), 99);
    }

    #[test]
    fn unity_contains_and_bepinex() {
        let rules = vec![
            rule(1, &[("basename", "winhttp.dll")]),
            rule(2, &[("ext", "dll"), ("contains", "plugins")]),
        ];
        assert_eq!(mod_classify(files(&["WINHTTP.DLL"]), rules.clone(), 99).unwrap(), 1);
        // contains 查尾段小写子串（对齐 basename(item).includes）：中间段不算
        assert_eq!(mod_classify(files(&["BepInEx/MyPlugins/x.txt"]), rules.clone(), 99).unwrap(), 99);
        assert_eq!(mod_classify(files(&["tools/myplugins_backup.zip"]), rules.clone(), 99).unwrap(), 2);
        assert_eq!(mod_classify(files(&["a/b.dll"]), rules.clone(), 99).unwrap(), 2);
    }

    #[test]
    fn reengine_priority() {
        // dinput8 → 2；reframework → 7；autorun → 1；plugins → 4；natives → 3；pak → 6
        let rules = vec![
            rule(2, &[("basename", "dinput8.dll")]),
            rule(7, &[("segment_ci", "reframework")]),
            rule(1, &[("segment_ci", "autorun")]),
            rule(4, &[("segment_ci", "plugins")]),
            rule(3, &[("segment_ci", "natives")]),
            rule(6, &[("ext", "pak")]),
        ];
        assert_eq!(mod_classify(files(&["DINPUT8.DLL"]), rules.clone(), 99).unwrap(), 2);
        assert_eq!(mod_classify(files(&["ReFrameWork/Autorun/x.lua"]), rules.clone(), 99).unwrap(), 7);
        assert_eq!(mod_classify(files(&["Natives\\x.pak"]), rules.clone(), 99).unwrap(), 3);
        assert_eq!(mod_classify(files(&["data.pak"]), rules.clone(), 99).unwrap(), 6);
    }

    #[test]
    fn ext_edge_cases_match_get_file_extension() {
        let rules = vec![rule(1, &[("ext", "pak")])];
        // 无点 / 首点 / 尾点皆不命中（对齐 getFileExtension 兜底空串）
        assert_eq!(mod_classify(files(&["pak"]), rules.clone(), 99).unwrap(), 99);
        assert_eq!(mod_classify(files(&[".pak"]), rules.clone(), 99).unwrap(), 99);
        assert_eq!(mod_classify(files(&["a."]), rules.clone(), 99).unwrap(), 99);
        assert_eq!(mod_classify(files(&["a.PAK"]), rules.clone(), 99).unwrap(), 1);
    }
}

/// 配置条目：ini 种 `section/key` 定位；raw 种忽略 entries 用 content 整包写。
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfgEntry {
 section: String,
 key: String,
 value: String,
 #[serde(default)]
 remove: bool,
}

/// 跨进程排他锁 + 同目录 tmp 写后 rename：锁防并发丢条目，rename 防半截文件。
fn lock_and_write(path: &std::path::Path, content: &str) -> Result<(), String> {
 if let Some(parent) = path.parent() {
 if !parent.as_os_str().is_empty() {
 std::fs::create_dir_all(parent).map_err(|error| format!("创建目录失败:{error}"))?;
 }
 }
 let lock_path = path.with_extension("gmm-lock");
 let lock_file = std::fs::OpenOptions::new()
 .create(true)
 .write(true)
 .open(&lock_path)
 .map_err(|error| format!("配置文件加锁失败:{error}"))?;
 use fs2::FileExt;
 lock_file
 .lock_exclusive()
 .map_err(|error| format!("配置文件加锁失败:{error}"))?;
 let tmp = path.with_extension("gmmtmp");
 let result = std::fs::write(&tmp, content)
 .map_err(|error| format!("写入文件失败:{error}"))
 .and_then(|()| std::fs::rename(&tmp, path).map_err(|error| format!("写入文件失败:{error}")));
 let _ = lock_file.unlock();
 let _ = std::fs::remove_file(&lock_path);
 result
}

fn ini_section_of(line: &str) -> Option<String> {
 let trimmed = line.trim();
 if trimmed.len() >= 2 && trimmed.starts_with('[') && trimmed.ends_with(']') {
 return Some(trimmed[1..trimmed.len() - 1].trim().to_string());
 }
 None
}

fn ini_key_of(line: &str) -> Option<(String, usize)> {
 let eq = line.find('=')?;
 Some((line[..eq].trim().to_string(), eq))
}

/// 行保留 ini 合并：只碰命中的 key 行（保留原 `key=` 前缀），缺 section/key 追加。
fn ini_upsert(current: &str, entries: &[CfgEntry]) -> String {
 let mut lines: Vec<String> = current.split('\n').map(|line| line.to_string()).collect();
 // split 永不为空，但空文件会产出 [""]，先归一为空表。
 if lines.len() == 1 && lines[0].trim().is_empty() {
 lines.clear();
 }
 for entry in entries {
 let mut section_at: Option<usize> = None;
 let mut key_at: Option<usize> = None;
 let mut section_end = lines.len();
 for (index, line) in lines.iter().enumerate() {
 if let Some(name) = ini_section_of(line) {
 if section_at.is_some() {
 section_end = index;
 break;
 }
 if name == entry.section {
 section_at = Some(index);
 section_end = lines.len();
 }
 } else if section_at.is_some() {
 if let Some((key, _)) = ini_key_of(line) {
 if key == entry.key {
 key_at = Some(index);
 break;
 }
 }
 }
 }
 if entry.remove {
 if let Some(at) = key_at {
 lines.remove(at);
 }
 continue;
 }
 if let Some(at) = key_at {
 let eq = lines[at].find('=').unwrap_or(0);
 lines[at] = format!("{}={}", &lines[at][..eq], entry.value);
 } else if let Some(_head) = section_at {
 lines.insert(section_end, format!("{}={}", entry.key, entry.value));
 } else {
 if !lines.is_empty() && !lines.last().map(|line| line.trim().is_empty()).unwrap_or(true) {
 lines.push(String::new());
 }
 lines.push(format!("[{}]", entry.section));
 lines.push(format!("{}={}", entry.key, entry.value));
 }
 }
 lines.join("\n")
}

/// kind: "ini"（行保留合并）| "raw"（content 整包原子写，由调用方组装 ini/xml 文本）。
#[tauri::command]
pub fn cfg_upsert(
 path: String,
 kind: String,
 entries: Vec<CfgEntry>,
 content: Option<String>,
) -> Result<(), String> {
 let target = std::path::PathBuf::from(&path);
 match kind.as_str() {
 "ini" => {
 let current = std::fs::read_to_string(&target).unwrap_or_default();
 lock_and_write(&target, &ini_upsert(&current, &entries))
 }
 "raw" => {
 let body = content.unwrap_or_default();
 lock_and_write(&target, &body)
 }
 _ => Err("未知配置类型".to_string()),
 }
}

#[cfg(test)]
mod cfg_tests {
 use super::*;

 fn entry(section: &str, key: &str, value: &str) -> CfgEntry {
 CfgEntry {
 section: section.to_string(),
 key: key.to_string(),
 value: value.to_string(),
 remove: false,
 }
 }

 #[test]
 fn ini_set_and_append_and_remove() {
 // 改现存 key：只换值，注释行与空行原样保留。
 let out = ini_upsert("[Archive]\nbInvalidateOlderFiles=0\n; comment\n", &[entry(
 "Archive",
 "bInvalidateOlderFiles",
 "1",
 )]);
 assert!(out.contains("bInvalidateOlderFiles=1"));
 assert!(out.contains("; comment"));
 // 同 section 追 key：落在 section 内、下一 section 之前。
 let out = ini_upsert("[A]\nx=1\n[B]\ny=2\n", &[entry("A", "z", "3")]);
 assert!(out.contains("[A]\nx=1\nz=3\n[B]"));
 // 新 section 追加。
 let out = ini_upsert("[A]\nx=1\n", &[entry("General", "sTestFile1", "foo.esp")]);
 assert!(out.contains("[General]\nsTestFile1=foo.esp"));
 // 删除。
 let out = ini_upsert(
 "[General]\nsTestFile1=foo.esp\nsTestFile2=bar.esp\n",
 &[CfgEntry {
 section: "General".to_string(),
 key: "sTestFile1".to_string(),
 value: String::new(),
 remove: true,
 }],
 );
 assert!(!out.contains("sTestFile1"));
 assert!(out.contains("sTestFile2=bar.esp"));
 // 空文件起建。
 let out = ini_upsert("", &[entry("Archive", "bInvalidateOlderFiles", "1")]);
 assert_eq!(out, "[Archive]\nbInvalidateOlderFiles=1");
 }

 #[test]
 fn raw_write_roundtrip() {
 let dir = std::env::temp_dir().join("gmm-cfg-raw");
 let _ = std::fs::remove_dir_all(&dir);
 let path = dir.join("sub").join("mods.xml");
 let body = "<?xml version=\"1.0\"?>\n<Mods />\n";
 cfg_upsert(
 path.to_string_lossy().to_string(),
 "raw".to_string(),
 vec![],
 Some(body.to_string()),
 )
 .unwrap();
 assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
 assert!(!path.with_extension("gmmtmp").exists());
 let _ = std::fs::remove_dir_all(&dir);
 }
}

/// 单链直调（替代 powershell New-Item）：原生 symlink，目录失败回退 Junction。
/// backup=true 即 `_back` 语义；失败已在内部回滚，调用方按 bool 记态。
#[tauri::command]
pub fn fs_link(src: String, dst: String, backup: bool) -> Result<bool, String> {
 let item = InstallItem {
 file: dst.clone(),
 src,
 dst,
 op: "link".to_string(),
 backup: if backup { "linkback".to_string() } else { "none".to_string() },
 content: None,
 };
 match op_link(&item, false) {
 Ok(()) => Ok(true),
 Err(error) => Err(error),
 }
}

/// 极简 VDF 值：字符串或嵌套表（libraryfolders/loginusers 只需此子集）。
enum Vdf {
 Str(String),
 Map(std::collections::HashMap<String, Vdf>),
}

fn vdf_tokens(text: &str) -> Vec<String> {
 let mut tokens = Vec::new();
 let mut chars = text.chars().peekable();
 while let Some(char) = chars.next() {
 if char == '"' {
 let mut buf = String::new();
 loop {
 match chars.next() {
 Some('\\') => {
 if let Some(escaped) = chars.next() {
 buf.push(escaped);
 }
 }
 Some('"') | None => break,
 Some(char) => buf.push(char),
 }
 }
 tokens.push(buf);
 } else if char == '{' || char == '}' {
 tokens.push(char.to_string());
 }
 }
 tokens
}

fn vdf_parse_map(tokens: &[String], pos: &mut usize) -> std::collections::HashMap<String, Vdf> {
 let mut map = std::collections::HashMap::new();
 while *pos < tokens.len() {
 if tokens[*pos] == "}" {
 break;
 }
 let key = tokens[*pos].clone();
 *pos += 1;
 if *pos < tokens.len() && tokens[*pos] == "{" {
 *pos += 1;
 let inner = vdf_parse_map(tokens, pos);
 if *pos < tokens.len() && tokens[*pos] == "}" {
 *pos += 1;
 }
 map.insert(key, Vdf::Map(inner));
 } else if *pos < tokens.len() {
 let value = tokens[*pos].clone();
 *pos += 1;
 map.insert(key, Vdf::Str(value));
 }
 }
 map
}

fn vdf_parse(text: &str) -> std::collections::HashMap<String, Vdf> {
 let tokens = vdf_tokens(text);
 let mut pos = 0;
 vdf_parse_map(&tokens, &mut pos)
}

fn vdf_str<'a>(map: &'a std::collections::HashMap<String, Vdf>, key: &str) -> Option<&'a str> {
 match map.get(key) {
 Some(Vdf::Str(value)) => Some(value),
 _ => None,
 }
}

#[cfg(windows)]
fn windows_steam_path() -> Option<String> {
    // release 包必须藏控制台窗口，否则每次 reg 查询都闪一个 cmd。
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = std::process::Command::new("reg");
    command.args([
        "query",
        "HKLM\\SOFTWARE\\Wow6432Node\\Valve\\Steam",
        "/v",
        "InstallPath",
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
 if !output.status.success() {
 return None;
 }
 let stdout = String::from_utf8_lossy(&output.stdout);
 for line in stdout.lines() {
 let mut parts = line.split_whitespace();
 if parts.next() == Some("InstallPath")
 && parts.next() == Some("REG_SZ")
 {
 return Some(parts.collect::<Vec<_>>().join(" "));
 }
 }
 None
}

fn valid_steam_dir(dir: &std::path::Path) -> bool {
 dir.join("steamapps").join("libraryfolders.vdf").exists()
 || dir.join("config").join("loginusers.vdf").exists()
}

/// Steam 安装目录：Windows 一次 reg 查询；其余平台按候选目录探测。
#[tauri::command]
pub fn scan_steam_install_path() -> Result<Option<String>, String> {
 #[cfg(windows)]
 if let Some(path) = windows_steam_path() {
 if valid_steam_dir(std::path::Path::new(&path)) {
 return Ok(Some(path));
 }
 }
 #[cfg(not(windows))]
 if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
 let candidates = [
 "Library/Application Support/Steam",
 ".local/share/Steam",
 ".steam/steam",
 ".steam/root",
 ".steam/debian-installation",
 ".var/app/com.valvesoftware.Steam/.local/share/Steam",
 ];
 for candidate in candidates {
 let dir = home.join(candidate);
 if valid_steam_dir(&dir) {
 return Ok(Some(dir.to_string_lossy().to_string()));
 }
 }
 }
 Ok(None)
}

fn library_game_root(steam_path: &str, app_id: u32) -> Option<String> {
 let vdf_path = std::path::Path::new(steam_path)
 .join("steamapps")
 .join("libraryfolders.vdf");
 let text = std::fs::read_to_string(&vdf_path).ok()?;
 let root = vdf_parse(&text);
 let needle = app_id.to_string();
 let folders = match root.get("libraryfolders") {
 Some(Vdf::Map(folders)) => folders,
 _ => return None,
 };
 for folder in folders.values() {
 let Vdf::Map(folder) = folder else { continue };
 let apps = match folder.get("apps") {
 Some(Vdf::Map(apps)) => apps,
 _ => continue,
 };
 if apps.contains_key(&needle) {
 return vdf_str(folder, "path").map(|path| path.to_string());
 }
 }
 None
}

/// 单次查询某 AppID 的游戏目录（一次 reg + 一次 VDF 解析，无 console 噪音）。
#[tauri::command]
pub fn scan_steam_game(app_id: u32, installdir: String) -> Result<Option<String>, String> {
 let steam_path = match scan_steam_install_path()? {
 Some(path) => path,
 None => return Ok(None),
 };
 let root = match library_game_root(&steam_path, app_id) {
 Some(root) => root,
 None => return Ok(None),
 };
 let mut game = std::path::PathBuf::from(root);
 game.push("steamapps");
 game.push("common");
 if !installdir.is_empty() {
 game.push(&installdir);
 }
 Ok(Some(game.to_string_lossy().to_string()))
}

/// 最近登录 Steam 用户的 32 位 ID（loginusers.vdf 取 Timestamp 最大者）。
#[tauri::command]
pub fn scan_steam_last_user() -> Result<String, String> {
 const BASE: u64 = 76561197960265728;
 let steam_path = match scan_steam_install_path()? {
 Some(path) => path,
 None => return Ok(String::new()),
 };
 let vdf_path = std::path::Path::new(&steam_path)
 .join("config")
 .join("loginusers.vdf");
 let text = std::fs::read_to_string(&vdf_path).unwrap_or_default();
 let root = vdf_parse(&text);
 let users = match root.get("users") {
 Some(Vdf::Map(users)) => users,
 _ => return Ok(String::new()),
 };
 let mut best: Option<(u64, u64)> = None;
 for (id, item) in users {
 let Vdf::Map(item) = item else { continue };
 let timestamp: u64 = vdf_str(item, "Timestamp").and_then(|value| value.parse().ok()).unwrap_or(0);
 let id64: u64 = match id.parse() {
 Ok(id) => id,
 Err(_) => continue,
 };
 if best.map(|(_, stamp)| timestamp > stamp).unwrap_or(true) {
 best = Some((id64, timestamp));
 }
 }
 match best {
 Some((id64, _)) if id64 >= BASE => Ok((id64 - BASE).to_string()),
 _ => Ok(String::new()),
 }
}

#[cfg(test)]
mod scan_tests {
 use super::*;

 #[test]
 fn vdf_library_lookup() {
 let text = "\"libraryfolders\"\n{\n\"0\"\n{\n\"path\"\t\t\"C:\\\\Steam\"\n\"apps\"\n{\n\"228980\"\t\t\"12345\"\n}\n}\n}\n";
 let root = vdf_parse(text);
 let folders = match &root["libraryfolders"] {
 Vdf::Map(folders) => folders,
 _ => panic!("folders"),
 };
 assert!(folders.contains_key("0"));
 }

 #[test]
 fn vdf_last_user_picks_max_timestamp() {
 let text = "\"users\"\n{\n\"76561197960265729\"\n{\n\"Timestamp\"\t\t\"100\"\n}\n\"76561197960265730\"\n{\n\"Timestamp\"\t\t\"200\"\n}\n}\n";
 let root = vdf_parse(text);
 let users = match &root["users"] {
 Vdf::Map(users) => users,
 _ => panic!("users"),
 };
 let mut best = (0u64, 0u64);
 for (id, item) in users {
 if let Vdf::Map(item) = item {
 let stamp: u64 = vdf_str(item, "Timestamp").and_then(|v| v.parse().ok()).unwrap_or(0);
 let id64: u64 = id.parse().unwrap();
 if stamp >= best.1 {
 best = (id64, stamp);
 }
 }
 }
 assert_eq!(best.0 - 76561197960265728, 2);
 }
}

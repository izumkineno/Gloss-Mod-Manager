fn main() {
    // tauri_build 默认通过 embed-resource 的 `rustc-link-arg-bins` 只给 bin 目标嵌
    // common-controls v6 manifest。测试二进制（lib unittest / integration test）拿不到
    // manifest → 无 SxS 激活上下文 → comctl32 绑定 System32 v5 → tao 导入的
    // `TaskDialogIndirect`（v6 独有）缺失 → 测试 exe 启动即 0xc0000139。
    //
    // 因此这里关闭 tauri_build 的 app manifest，改由下方统一对所有目标（bin + test）
    // 用链接器 /MANIFEST:EMBED 嵌入同一份 manifest，保持单一来源、无重复资源冲突。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("tauri-build failed");
    embed_windows_manifest();
}

/// 对所有链接目标（bin/test/bench/example）统一嵌入 common-controls v6 manifest。
/// 内容与 tauri_build 默认 app manifest 完全一致（仅 common-controls v6 依赖）。
fn embed_windows_manifest() {
    // 仅 MSVC 链接器支持 /MANIFEST:EMBED /MANIFESTINPUT 参数。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR must be set by cargo");
    let manifest_path = std::path::Path::new(&out_dir).join("app.manifest");
    std::fs::write(
        &manifest_path,
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .expect("write app.manifest");
    // /MANIFESTINPUT 必须与 /MANIFEST:EMBED 成对出现（缺一会报 LNK1220）。
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}

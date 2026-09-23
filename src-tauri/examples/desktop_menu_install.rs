//! 一次性探针（不参与发布）：把桌面右键菜单按**产品逻辑**装一遍，并打印注册表里的真实结构。
//!
//! # 为什么要单独跑一遍
//!
//! V60 把菜单从「孤零零一项」扩成了 `SubCommands` + GUID 子键的**分组子菜单**。这套写法
//! 有三个「写错了不报错、只是菜单整条不出现」的坑（见 `platform/desktop_menu.rs` 文件头）：
//! 子键名不是 GUID 形状、`SubCommands` 值被删掉、旧版 `command` 子键没清掉。
//!
//! 这三条**单元测试覆盖不到** —— 它们取决于 Explorer 怎么解析注册表，只能在真机上装好之后
//! 拿 `reg query` 看结构。所以留了这个探针。
//!
//! # 用法
//!
//! ```text
//! cargo run --release --example desktop_menu_install             # 安装并打印结构
//! cargo run --release --example desktop_menu_install -- --remove # 卸载
//! ```

const MENU_KEY: &str = r"HKCU\Software\Classes\DesktopBackground\Shell\HandyDesktopGrid";

fn main() {
    let remove = std::env::args().any(|arg| arg == "--remove");

    if remove {
        match handy_lib::platform::desktop_menu::remove() {
            Ok(()) => println!("remove() → Ok（菜单项已删除）"),
            Err(err) => println!("remove() → Err：{err}"),
        }
        return;
    }

    match handy_lib::platform::desktop_menu::install() {
        Ok(()) => println!("install() → Ok"),
        Err(err) => {
            println!("install() → Err：{err}");
            std::process::exit(1);
        }
    }
    println!(
        "status() → {:?}\n",
        handy_lib::platform::desktop_menu::status()
    );

    let out = std::process::Command::new("reg")
        .args(["query", MENU_KEY, "/s"])
        .output()
        .expect("调用 reg.exe 失败");
    println!("=== reg query {} /s ===", MENU_KEY);
    print!("{}", String::from_utf8_lossy(&out.stdout));
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        println!("--- stderr ---\n{err}");
    }
}

//! 工作台「快捷入口」——系统级快捷动作（命令提示符 / 网络 / 系统管理面板）。
//!
//! # 安全设计（关键，勿改）
//!
//! 前端**只能传动作 id**，不接受任何可执行文件路径或命令行参数。所有可启动的目标
//! 与参数都在本文件的白名单表 [`table`] 里硬编码，前端无法构造新的命令，
//! 因此**从根上不存在命令注入面**。这比提供「通用 shell 执行」命令安全得多，
//! 也符合产品定位（工具型软件不该给自身开任意执行的后门）。
//!
//! # 三类启动方式
//!
//! - [`Launch::Open`]：交给系统 shell 打开（`ms-settings:` 协议、`.cpl` 控制面板小程序、
//!   `.msc` 管理单元、文件、目录）——底层为 Win32 `ShellExecuteW`；
//! - [`Launch::Spawn`]：直接启动固定程序（**仅限真 PE 可执行文件**，如 `taskmgr.exe`）；
//! - [`Launch::Elevated`]：经 PowerShell `Start-Process -Verb RunAs` 触发 UAC 提权后启动。
//!
//! ⚠️ `.cpl` / `.msc` / 目录**绝不能**用 `Launch::Spawn`：它们不是可执行文件，
//! `std::process::Command` 会报 `os error 193`（曾是「网络连接」等入口点不开的根因）。
//!
//! 平台边界：本模块为 Windows 系统管理面板而设，非 Windows 平台返回明确的中文错误
//! （不静默失败）。全部命令均为 `async fn`（项目 P0 约定）。

use serde::Serialize;

/// 动作元数据（前端渲染按钮用；`table()` 的顺序即展示顺序）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysAction {
    /// 动作 id（前端唯一可传的参数）
    pub id: String,
    /// 按钮标题
    pub name: String,
    /// 一句话说明
    pub description: String,
    /// 分组名（前端按组渲染）
    pub group: String,
    /// 是否需要管理员权限（前端加「管理员」角标）
    pub elevated: bool,
}

/// 启动方式。
enum Launch {
    /// 用系统默认程序打开（协议 / 文件 / 目录）
    Open(String),
    /// 直接启动（固定参数）
    Spawn { program: String, args: Vec<String> },
    /// 提权启动（触发 UAC）
    Elevated { program: String, args: Vec<String> },
}

/// 白名单条目。`launch` 为无捕获闭包，故可退化为函数指针。
struct Entry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    group: &'static str,
    elevated: bool,
    launch: fn() -> Launch,
}

// —— 路径辅助（系统目录不写死盘符，兼容非 C: 安装） ——

/// `%SystemRoot%\System32\<name>`
fn system32(name: &str) -> String {
    match std::env::var("SystemRoot") {
        Ok(root) => format!("{root}\\System32\\{name}"),
        Err(_) => format!("C:\\Windows\\System32\\{name}"),
    }
}

/// `%SystemRoot%\System32\drivers\etc`（`name` 为空时返回目录本身，不带尾反斜杠）
fn drivers_etc(name: &str) -> String {
    let base = match std::env::var("SystemRoot") {
        Ok(root) => format!("{root}\\System32\\drivers\\etc"),
        Err(_) => "C:\\Windows\\System32\\drivers\\etc".to_string(),
    };
    if name.is_empty() {
        base
    } else {
        format!("{base}\\{name}")
    }
}

/// 无参数辅助：返回 `Launch::Open`
fn open(target: impl Into<String>) -> Launch {
    Launch::Open(target.into())
}

/// 无参数辅助：返回不带参数的 `Launch::Spawn`
fn spawn(program: impl Into<String>) -> Launch {
    Launch::Spawn {
        program: program.into(),
        args: Vec::new(),
    }
}

/// 提权启动 `notepad.exe <文件>`（用于 hosts 等系统文件的编辑）
fn elevated_notepad(path: String) -> Launch {
    Launch::Elevated {
        program: system32("notepad.exe"),
        args: vec![path],
    }
}

/// 全量动作表（顺序即界面顺序；新增动作**只在此处追加**）。
fn table() -> Vec<Entry> {
    vec![
        // ——— 终端 ———
        Entry {
            id: "powershell-admin",
            name: "管理员 PowerShell",
            description: "以管理员身份打开 PowerShell",
            group: "终端",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("WindowsPowerShell\\v1.0\\powershell.exe"),
                args: vec!["-NoExit".to_string()],
            },
        },
        Entry {
            id: "cmd-admin",
            name: "管理员 CMD",
            description: "以管理员身份打开命令提示符",
            group: "终端",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("cmd.exe"),
                args: vec!["/k".to_string()],
            },
        },
        Entry {
            id: "powershell",
            name: "PowerShell",
            description: "以当前权限打开 PowerShell",
            group: "终端",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("WindowsPowerShell\\v1.0\\powershell.exe"),
                args: vec!["-NoExit".to_string()],
            },
        },
        Entry {
            id: "ipconfig",
            name: "查看 IP 配置",
            description: "ipconfig /all：本机网卡与地址一览",
            group: "终端",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("cmd.exe"),
                args: vec![
                    "/k".to_string(),
                    "ipconfig".to_string(),
                    "/all".to_string(),
                ],
            },
        },
        // ——— 网络 ———
        Entry {
            id: "ncpa",
            name: "网络连接",
            description: "ncpa.cpl：网卡属性 / IP / DNS 在这里改",
            group: "网络",
            elevated: false,
            launch: || open(system32("ncpa.cpl")),
        },
        Entry {
            id: "dns-flush",
            name: "刷新 DNS 缓存",
            description: "ipconfig /flushdns（需管理员）",
            group: "网络",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("cmd.exe"),
                args: vec![
                    "/k".to_string(),
                    "ipconfig".to_string(),
                    "/flushdns".to_string(),
                ],
            },
        },
        Entry {
            id: "hosts-edit",
            name: "编辑 hosts",
            description: "用管理员记事本打开 hosts 文件",
            group: "网络",
            elevated: true,
            launch: || elevated_notepad(drivers_etc("hosts")),
        },
        Entry {
            id: "hosts-folder",
            name: "打开 hosts 目录",
            description: "定位到 drivers\\etc 目录",
            group: "网络",
            elevated: false,
            launch: || open(drivers_etc("")),
        },
        Entry {
            id: "network-settings",
            name: "网络状态",
            description: "Windows 网络设置页",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-status"),
        },
        Entry {
            id: "wifi-settings",
            name: "WLAN 设置",
            description: "无线网络与已知网络管理",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-wifi"),
        },
        Entry {
            id: "proxy-settings",
            name: "代理设置",
            description: "系统代理 / 手动代理服务器",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-proxy"),
        },
        // ——— 系统管理 ———
        Entry {
            id: "taskmgr",
            name: "任务管理器",
            description: "进程 / 性能 / 启动项",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("taskmgr.exe")),
        },
        Entry {
            id: "services",
            name: "服务",
            description: "services.msc：服务启停与启动类型",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("services.msc")),
        },
        Entry {
            id: "device-mgr",
            name: "设备管理器",
            description: "devmgmt.msc：驱动与硬件",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("devmgmt.msc")),
        },
        Entry {
            id: "disk-mgr",
            name: "磁盘管理",
            description: "diskmgmt.msc：分区与盘符",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("diskmgmt.msc")),
        },
        Entry {
            id: "event-viewer",
            name: "事件查看器",
            description: "eventvwr.msc：系统与应用日志",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("eventvwr.msc")),
        },
        Entry {
            id: "firewall",
            name: "防火墙",
            description: "wf.msc：高级安全 Windows 防火墙",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("wf.msc")),
        },
        Entry {
            id: "registry",
            name: "注册表编辑器",
            description: "regedit（改动前请先备份）",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("regedit.exe")),
        },
        Entry {
            id: "system-info",
            name: "系统信息",
            description: "msinfo32：软硬件摘要",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("msinfo32.exe")),
        },
        Entry {
            id: "perfmon",
            name: "性能监视器",
            description: "perfmon：性能计数器",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("perfmon.msc")),
        },
        Entry {
            id: "env-vars",
            name: "环境变量",
            description: "用户 / 系统环境变量编辑",
            group: "系统管理",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("rundll32.exe"),
                args: vec![
                    "sysdm.cpl,EditEnvironmentVariables".to_string(),
                ],
            },
        },
        Entry {
            id: "system-props",
            name: "系统属性",
            description: "sysdm.cpl：计算机名 / 远程 / 还原",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("sysdm.cpl")),
        },
        Entry {
            id: "programs",
            name: "程序和功能",
            description: "appwiz.cpl：卸载 / 修复软件",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("appwiz.cpl")),
        },
        Entry {
            id: "windows-update",
            name: "Windows 更新",
            description: "检查更新与更新历史",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:windowsupdate"),
        },
        Entry {
            id: "startup-apps",
            name: "启动应用",
            description: "开机自启项开关",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:startupapps"),
        },
        Entry {
            id: "display-settings",
            name: "显示设置",
            description: "分辨率 / 缩放 / 多显示器",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:display"),
        },
        Entry {
            id: "storage-settings",
            name: "存储设置",
            description: "磁盘占用与感知清理",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:storagesense"),
        },
        Entry {
            id: "power",
            name: "电源选项",
            description: "powercfg.cpl：电源计划",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("powercfg.cpl")),
        },
        Entry {
            id: "date-time",
            name: "日期和时间",
            description: "timedate.cpl：时区与校时",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("timedate.cpl")),
        },
        Entry {
            id: "sound",
            name: "声音",
            description: "mmsys.cpl：播放 / 录音设备",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("mmsys.cpl")),
        },
        Entry {
            id: "control-panel",
            name: "控制面板",
            description: "经典控制面板入口",
            group: "系统管理",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("control.exe"),
                args: Vec::new(),
            },
        },
        Entry {
            id: "temp-folder",
            name: "临时文件目录",
            description: "%TEMP%：可安全清理的临时目录",
            group: "系统管理",
            elevated: false,
            launch: || {
                let dir = std::env::temp_dir();
                open(dir.to_string_lossy().to_string())
            },
        },
    ]
}

/// 动作清单（前端渲染「快捷入口」网格）。
#[tauri::command]
pub async fn sys_action_list() -> Result<Vec<SysAction>, String> {
    Ok(table()
        .into_iter()
        .map(|entry| SysAction {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            group: entry.group.to_string(),
            elevated: entry.elevated,
        })
        .collect())
}

/// 以管理员身份启动（经 PowerShell `Start-Process -Verb RunAs` 触发 UAC）。
///
/// 参数均为白名单内的字面量，仍按 PowerShell 单引号规则转义（单引号翻倍），
/// 保证含空格 / 特殊字符的路径（如 non-C: 的系统盘、带空格用户名）不被拆坏。
fn launch_elevated(program: &str, args: &[String]) -> Result<(), String> {
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
    let mut script = format!("Start-Process -FilePath {}", quote(program));
    if !args.is_empty() {
        let list = args
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(",");
        script.push_str(&format!(" -ArgumentList {list}"));
    }
    script.push_str(" -Verb RunAs");

    let mut command = std::process::Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 隐藏这个只负责「拉起 UAC」的中间进程，避免黑框一闪
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| format!("请求管理员权限失败：{err}"))?;
    Ok(())
}

/// 直接启动（固定参数，不创建窗口标记 —— 需要控制台的程序要保留自己的控制台）。
fn launch_spawn(program: &str, args: &[String]) -> Result<(), String> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|err| format!("启动「{program}」失败：{err}"))?;
    Ok(())
}

/// 交给系统 shell「打开」一个目标（协议 / 文件 / 目录 / 控制面板小程序）。
///
/// # 为什么必须用 `ShellExecuteW` 而不是 `Command::new`
///
/// `.cpl`（控制面板小程序）、`.msc`（管理单元）**不是 PE 可执行文件**，
/// 用 `std::process::Command` 直接执行会失败并报
/// `%1 不是有效的 Win32 应用程序 (os error 193)`。`ShellExecuteW` 走的才是
/// 资源管理器双击那条路（由注册表关联决定真实处理程序），因此
/// `ncpa.cpl` / `services.msc` / 目录 / `ms-settings:` 协议全部由此统一处理。
///
/// 也刻意不经 `tauri-plugin-shell::open`（该 API 自 2.1 起已废弃），
/// 直接用已启用的 `Win32_UI_Shell` 绑定，行为完全自主可控。
#[cfg(target_os = "windows")]
fn launch_open(target: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// UTF-16 + NUL 结尾（Win32 宽字符约定）
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let file = wide(target);
    // SAFETY: 两个 PCWSTR 均指向本函数内仍存活的 NUL 结尾宽字符串；
    // 其余参数为固定字面量（无 lpParameters / lpDirectory），无别名与生命周期问题。
    let handle = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW 的约定：返回值 <= 32 表示失败（32 以上是成功实例句柄）
    let code = handle.0 as isize;
    if code <= 32 {
        return Err(format!("系统未能打开「{target}」（ShellExecute 代码 {code}）"));
    }
    Ok(())
}

/// 非 Windows 平台：明确报错，不静默失败。
#[cfg(not(target_os = "windows"))]
fn launch_open(target: &str) -> Result<(), String> {
    Err(format!("「{target}」的打开方式仅支持 Windows 系统"))
}

/// 执行一个快捷动作（`actionId` 必须在白名单内，否则报错）。
#[tauri::command]
pub async fn sys_action_run(action_id: String) -> Result<(), String> {
    let Some(entry) = table().into_iter().find(|item| item.id == action_id) else {
        return Err(format!("未知的快捷动作：{action_id}"));
    };
    if !cfg!(target_os = "windows") {
        return Err(format!("「{}」目前仅支持 Windows 系统", entry.name));
    }
    let name = entry.name;
    match (entry.launch)() {
        Launch::Open(target) => launch_open(&target),
        Launch::Spawn { program, args } => launch_spawn(&program, &args),
        Launch::Elevated { program, args } => launch_elevated(&program, &args),
    }
    .map_err(|err| format!("{name}：{err}"))
}

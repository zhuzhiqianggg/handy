//! Handy · 顺手 —— Rust 原生层入口。
//!
//! 职责：装配 Tauri Builder（插件 / 命令 / 托盘 / 快捷键 / 单实例 / DB 初始化）。
//! 平台差异全部下沉到 `platform/` 适配层，业务代码不写运行时平台分支。

pub mod commands;
pub mod db;
pub mod logging;
pub mod platform;
pub mod shortcut;
pub mod tray;
pub mod window;

/// 应用入口。
///
/// 注意：`tauri-plugin-single-instance` **必须最先注册**，否则无法拦截二次启动（见 DEVELOPMENT §11）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // —— 单实例：必须第一个注册，拦截第二次启动并唤起已有实例 ——
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = window::show_main_palette(app);
        }))
        // —— 日志 ——
        .plugin(tauri_plugin_log::Builder::new().build())
        // —— 配置态持久化（settings.json，非关系型小配置）——
        .plugin(tauri_plugin_store::Builder::default().build())
        // —— SQLite 数据层（便签/待办/历史）；表结构与迁移见 `db/` ——
        .plugin(tauri_plugin_sql::Builder::default().build())
        // —— 系统能力插件 ——
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // —— 全局快捷键（默认 Alt+Space / Option+Space）——
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::app::platform_info,
            commands::app::app_quit,
            commands::app::app_show_main,
            // 统一日志（V37）：前端错误上报 + 用户自助查看/清空
            logging::log_frontend,
            logging::log_open_dir,
            logging::log_read_tail,
            logging::log_clear,
            logging::log_info,
            commands::app::app_hide_main,
            commands::app::app_toggle_main,
            commands::app::app_set_pinned,
            commands::app::module_list_state,
            commands::app::module_set_enabled,
            // —— 便签（M3 / V08）——
            commands::notes::notes_list,
            commands::notes::notes_create,
            commands::notes::notes_update,
            commands::notes::notes_delete,
            commands::notes::notes_set_geometry,
            commands::notes::open_note_window,
            // —— 待办（M3 / V09）——
            commands::todos::todos_list,
            commands::todos::todos_create,
            commands::todos::todos_update,
            commands::todos::todos_delete,
            commands::todos::todos_toggle_done,
            // —— 密码存储器（M5 / vault）——
            commands::vault::vault_setup,
            commands::vault::vault_status,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_list,
            commands::vault::vault_create,
            commands::vault::vault_update,
            commands::vault::vault_delete,
            // —— 桌面整理（M2 / V12）——
            commands::organizer::organizer_scan_desktop,
            commands::organizer::organizer_preview_plan,
            commands::organizer::organizer_update_plan_items,
            commands::organizer::organizer_apply,
            commands::organizer::organizer_undo,
            commands::organizer::organizer_list_plans,
            // —— 桌面网格挂件（M2 改版：文件引用型，绝不移动文件）——
            commands::grid::grid_overlay_show,
            commands::grid::grid_overlay_hide,
            commands::grid::grid_overlay_status,
            commands::grid::grid_set_interactive,
            commands::grid::grid_overlay_update_regions,
            commands::grid::grid_overlay_heartbeat,
            commands::grid::grid_overlay_fault,
            commands::grid::grid_overlay_fault_get,
            commands::grid::grid_box_list,
            commands::grid::grid_box_upsert,
            commands::grid::grid_box_delete,
            commands::grid::grid_box_set_content,
            commands::grid::grid_item_add,
            commands::grid::grid_item_delete,
            commands::grid::grid_item_move,
            commands::grid::grid_item_list,
            commands::grid::grid_geometry_get,
            commands::grid::grid_geometry_set,
            commands::grid::grid_open_path,
            // —— 接口测试（api-tester，V28）：Rust 直发 HTTP，绕开 webview CORS ——
            commands::http::http_request,
            // —— 桌面层挂载 / 系统图标显隐（V20：真正画在桌面上）——
            commands::grid::grid_attach_get,
            commands::grid::grid_attach_set,
            commands::grid::grid_desktop_icons_set,
            commands::grid::grid_desktop_icons_get,
            // —— 桌面整理：一键整理 / 布局备份与还原（V19）——
            commands::grid::grid_auto_arrange,
            commands::grid::grid_desktop_sync,
            commands::grid::grid_file_icon,
            // V37：历史收纳残留（预览 / 撤回桌面 / 清理）+ 桌面图标尺寸
            commands::grid::grid_legacy_scan,
            commands::grid::grid_legacy_reclaim,
            commands::grid::grid_legacy_cleanup,
            commands::grid::desktop_icon_metrics,
            commands::grid::grid_layout_export,
            commands::grid::grid_layout_import,
            commands::grid::grid_layout_save,
            commands::grid::grid_layout_list,
            commands::grid::grid_layout_restore,
            commands::grid::grid_layout_delete,
            // —— 系统快捷动作（工作台「快捷入口」；白名单制，前端只传动作 id）——
            commands::sys::sys_action_list,
            commands::sys::sys_action_run,
            // —— 工作台顶部贴条（常驻桌面顶部的今日概览）——
            commands::bar::bar_show,
            commands::bar::bar_hide,
            commands::bar::bar_set_height,
            commands::bar::bar_set_pinned,
            commands::bar::bar_open_workstation,
            commands::bar::bar_open_command,
            // —— 设置中心 / 备份（M7 / V13）——
            commands::app::hotkey_update,
            commands::app::debug_log,
            commands::backup::backup_export,
            commands::backup::backup_import,
        ])
        .setup(|app| {
            // V37：每次启动在日志里画一条分隔线并写上版本号 —— 用户回传的日志里
            // 必须能分清「这是哪一次运行」，否则相邻几次运行会搅在一起没法读。
            logging::start_session(&app.package_info().version.to_string());
            // 待导入备份：必须在 db::init 之前应用（覆盖库文件后新连接才读新数据）
            match commands::backup::apply_pending_import_for_app(app.handle()) {
                Ok(true) => println!("[Handy] 已应用待导入备份（重启后全部生效）"),
                Ok(false) => {}
                Err(err) => eprintln!("[Handy] 应用待导入备份失败（已清除标记）：{err}"),
            }
            // 托盘 / 菜单栏
            if let Err(err) = tray::setup(app.handle()) {
                eprintln!("[Handy] 托盘初始化失败：{err}");
            }
            // 全局快捷键（优先 settings.json 已保存键，失败回退平台默认）
            if let Err(err) = shortcut::register_from_settings(app.handle()) {
                eprintln!("[Handy] 快捷键注册失败：{err}");
            }
            // 主窗口关闭 → 隐藏到托盘（常驻，不退出应用）
            window::attach_close_to_tray(app.handle());
            // 初始化 SQLite 主数据层（WAL + 版本迁移，路径与 sql 插件 preload 一致）
            match db::init(app.handle()) {
                Ok(path) => println!("[Handy] 数据库就绪：{}", path.display()),
                Err(err) => eprintln!("[Handy] 数据库初始化失败：{err}"),
            }
            // 桌面格子层「永久生效」：上次显示中（含重启前就在接管）→ 本次启动自动摆回桌面
            commands::grid::restore_overlay_if_visible(app.handle());
            // 主窗口启动显示（V16 修复）：`visible:false` 交给逻辑控制显隐，
            // 首启必须显式 show —— 否则窗口一直隐藏、需手动点托盘才出现（"退出再开不显示"）。
            // 置于托盘 / 快捷键 / DB 之后，确保托盘兜底与数据层就绪再亮窗。
            if let Err(err) = window::show_main_palette(app.handle()) {
                eprintln!("[Handy] 启动显示主窗口失败：{err}");
            }
            // 无头测试通道：HANDY_AUTOTOOL=<commandId> 或 module:<moduleId>，
            // 延迟 4s 后发给主窗口（等前端监听就绪），用于自动化诊断/回归，无此变量时零开销。
            if let Ok(target) = std::env::var("HANDY_AUTOTOOL") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    use tauri::{Emitter, Manager};
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.emit("autotool", target);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Handy 失败")
        .run(|_app, event| {
            // 退出兜底（V20）：桌面整理可以把系统图标藏起来，退出时必须还回去，
            // 否则用户会面对一个「应用没了、图标也没了」的桌面。
            if let tauri::RunEvent::Exit = event {
                commands::grid::restore_desktop_icons();
            }
        });
}

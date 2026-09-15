import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Plus, X } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { useTodosStore } from '@/stores/useTodosStore';
import { useAppStore } from '@/stores/useAppStore';
import type { Todo } from '@/core/data/todosService';
import { startOfDay, DAY_MS } from './planUtils';

/**
 * 工作台顶部贴条（`windowRoot = 'workstation-bar'`）。
 *
 * 常驻桌面顶部的一行「今日概览」：现在几点 · 今天还剩几件 · 最近的三件（可直接勾掉）·
 * 一键打开工作台 / 收起贴条。
 *
 * 实现说明：
 *   - 贴条是独立 WebView，但经 `tauri-plugin-sql` 直连同一个 `handy.db`，
 *     所以这里直接复用 `useTodosStore` —— 与主窗口看到的是同一批数据，勾选实时同步；
 *   - 窗口本身透明无边框（见 Rust `commands/bar.rs`），故根节点用半透明深色卡片，
 *     在任意壁纸上都清晰可读；同时清空 html/body 底色，否则透明会变成白块。
 */

/** 贴条上最多展示几条未完成 */
const VISIBLE_LIMIT = 3;

/** 时钟 HH:mm */
function clockOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WorkstationBar(): React.JSX.Element {
  const todos = useTodosStore((state) => state.todos);
  const hydrate = useTodosStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 透明窗：html/body 默认底色会破坏圆角透明
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 贴条上的「随手记一条」：内联输入态 + 草稿 */
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  /**
   * 今天的完整集合（含已完成）。
   *
   * 口径：**到期日在今天**的待办 + **无到期日**的（后者随时可做，不列出来就会一直被忽略）。
   * 已完成的部分用来算进度，让「今天推进得怎么样」一眼可见。
   */
  const todayAll = useMemo(() => {
    const dayStart = startOfDay(now);
    const dayEnd = dayStart + DAY_MS;
    return todos.filter((todo) => {
      if (todo.dueAt === null) {
        return true;
      }
      return todo.dueAt >= dayStart && todo.dueAt < dayEnd;
    });
  }, [todos, now]);

  /** 今天尚未完成的（贴条只列这些） */
  const todayPending = useMemo(
    () => todayAll.filter((todo) => !todo.done),
    [todayAll],
  );

  /** 今天已完成数（进度分母 = todayAll.length） */
  const todayDone = todayAll.length - todayPending.length;

  const overdueCount = useMemo(() => {
    const dayStart = startOfDay(now);
    return todos.filter((todo) => !todo.done && todo.dueAt !== null && todo.dueAt < dayStart).length;
  }, [todos, now]);

  /** 贴条内直接新建一条今日待办（09:00 或当前时间，取较晚者） */
  const submitDraft = useCallback((): void => {
    const title = draft.trim();
    setDraft('');
    setAdding(false);
    if (title === '') {
      return;
    }
    const dayStart = startOfDay(Date.now());
    const nine = dayStart + 9 * 3600_000;
    const dueAt = Math.max(nine, Date.now());
    void useTodosStore
      .getState()
      .createTodo({ title, dueAt })
      .catch(() => undefined);
  }, [draft]);

  const toggle = useCallback((id: string): void => {
    void useTodosStore.getState().toggleDone(id).catch(() => undefined);
  }, []);

  const openWorkstation = useCallback((): void => {
    void ipc.barOpenWorkstation().catch(() => undefined);
  }, []);

  /**
   * 收起贴条：**先**把 `barPinned` 写成 false，再隐藏窗口。
   *
   * 贴条是独立 WebView，与主窗口各持一份 store，所以这里的设置写入不会触发
   * 主窗口的订阅回调（订阅只在主窗口生效），窗口隐藏仍需直接调 `bar_hide`；
   * 而写入 `barPinned=false` 的作用是让**下次启动不再自动贴回**。
   */
  const hide = useCallback((): void => {
    void useAppStore.getState().updateSettings({ barPinned: false }).catch(() => undefined);
    void ipc.barHide().catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full w-full items-center gap-3 rounded-xl bg-neutral-900/85 px-3 text-neutral-100 shadow-lg ring-1 ring-white/10 backdrop-blur-md">
      {/* 时间 + 计数 */}
      <div className="flex shrink-0 items-center gap-2" data-tauri-drag-region>
        <span className="text-sm font-semibold tabular-nums">{clockOf(now)}</span>
        <span className="text-[11px] text-neutral-300">
          今天 <span className="font-semibold text-white">{todayPending.length}</span> 项
        </span>
        {overdueCount > 0 ? (
          <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-200">
            逾期 {overdueCount}
          </span>
        ) : null}
        {/* 今日进度：静默地告诉你「今天推到哪了」，不用点开任何东西 */}
        {todayAll.length > 0 ? (
          <span
            className="flex items-center gap-1 text-[10px] text-neutral-400"
            title={`今日进度：已完成 ${todayDone} / 共 ${todayAll.length}`}
          >
            <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/15">
              <span
                className="block h-full rounded-full bg-emerald-400 transition-all"
                style={{ width: `${Math.round((todayDone / todayAll.length) * 100)}%` }}
              />
            </span>
            <span className="tabular-nums">
              {todayDone}/{todayAll.length}
            </span>
          </span>
        ) : null}
      </div>

      <span className="h-5 w-px shrink-0 bg-white/15" />

      {/* 待办速览（点击即完成，划掉） / 内联快速新增 */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submitDraft();
              }
              if (event.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={submitDraft}
            placeholder="写点什么，回车加到今天…"
            className="min-w-0 flex-1 rounded-md bg-white/10 px-2 py-1 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-400"
            aria-label="快速添加今日待办"
          />
        ) : todayPending.length === 0 ? (
          <span className="truncate text-[11px] text-neutral-300">
            今天没有待办 —— 点「＋」随手记一条，或「打开工作台」安排一下
          </span>
        ) : (
          todayPending.slice(0, VISIBLE_LIMIT).map((todo: Todo) => (
            <button
              key={todo.id}
              type="button"
              onClick={() => toggle(todo.id)}
              title="点击标记完成"
              className="group flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-left transition hover:bg-white/15"
            >
              <span className="h-3 w-3 shrink-0 rounded-full border border-neutral-400 transition group-hover:border-emerald-400 group-hover:bg-emerald-400/30" />
              <span className="min-w-0 truncate text-[11px] text-neutral-100">{todo.title || '未命名'}</span>
            </button>
          ))
        )}
        {!adding && todayPending.length > VISIBLE_LIMIT ? (
          <span className="shrink-0 text-[10px] text-neutral-400">
            +{todayPending.length - VISIBLE_LIMIT}
          </span>
        ) : null}
      </div>

      {/* 动作 */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setAdding(true)}
          title="快速添加一条今天的待办"
          className="rounded-md bg-white/10 p-1 transition hover:bg-white/20"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={openWorkstation}
          title="打开工作台（日历 / 计划 / 笔记 / 快捷入口）"
          className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] transition hover:bg-white/20"
        >
          <LayoutDashboard className="h-3 w-3" />
          打开工作台
        </button>
        <button
          type="button"
          onClick={hide}
          title="收起贴条（可在工作台里重新贴回）"
          className="rounded-md p-1 text-neutral-400 transition hover:bg-red-500/30 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export default WorkstationBar;

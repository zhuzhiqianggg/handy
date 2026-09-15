import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, LayoutDashboard, Pin, PinOff, Plus, X } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { readSettings } from '@/lib/store';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
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
 * # V20 增强：多行展开 + 手动折叠（用户反馈）
 *
 * 「看这个贴条其实可以多行，展示今日待办事项，用户可以手动收起折叠上去，或者下拉展示下来」：
 *   - **折叠态**（默认）= 原来那一行，最省桌面；
 *   - **展开态** = 标题行之下多出一块今日待办清单，两列铺开、每条可点勾完成，
 *     已完成的排在后面并以删除线弱化，一眼看出「今天推到哪了」；
 *   - 展开 / 折叠**记忆**在 localStorage（贴条与主窗口同 origin，共用一份），下次开机保持；
 *   - 窗口高度**跟着内容走**：这里量出真实内容高度后调 `bar_set_height`，
 *     Rust 侧保持「顶部居中」锚点只改高（贴条是 `resizable(false)`，用户拖不动，但程序可以）。
 *
 * 实现说明：
 *   - 贴条是独立 WebView，但经 `tauri-plugin-sql` 直连同一个 `handy.db`，
 *     所以这里直接复用 `useTodosStore` —— 与主窗口看到的是同一批数据，勾选实时同步；
 *   - 窗口本身透明无边框（见 Rust `commands/bar.rs`），故根节点用半透明深色卡片，
 *     在任意壁纸上都清晰可读；同时清空 html/body 底色，否则透明会变成白块；
 *   - 卡片外面套一层 `w-full` 的**量高壳**：壳不受窗口高度影响（auto height），
 *     把壳的高度报给 Rust 才不会「窗口高 → 量出窗口高」形成自激循环。
 */

/** 折叠态最多展示几条未完成 */
const COLLAPSED_LIMIT = 3;
/** 展开态最多展示几条（含已完成；再多贴条就变成第二块屏幕了） */
const EXPANDED_LIMIT = 12;
/** 展开 / 折叠状态的持久化键 */
const EXPANDED_KEY = 'handy.bar.expanded';

/** 时钟 HH:mm */
function clockOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 待办排序：优先级高的在前 → 到期早的在前（无到期排最后）→ 建得早的在前 */
function compareTodos(a: Todo, b: Todo): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  if (a.dueAt === null && b.dueAt === null) {
    return a.createdAt - b.createdAt;
  }
  if (a.dueAt === null) {
    return 1;
  }
  if (b.dueAt === null) {
    return -1;
  }
  return a.dueAt - b.dueAt;
}

/** 今天有具体时刻才算「时间标签」，否则不显示（无到期的别硬塞个 00:00） */
function dueLabelOf(todo: Todo, dayStart: number, dayEnd: number): string | null {
  if (todo.dueAt === null || todo.dueAt < dayStart || todo.dueAt >= dayEnd) {
    return null;
  }
  return clockOf(todo.dueAt);
}

/** 单条待办（折叠 / 展开共用；点击即勾掉） */
function TodoChip({
  todo,
  dayStart,
  dayEnd,
  fill,
  onToggle,
}: {
  todo: Todo;
  dayStart: number;
  dayEnd: number;
  fill: boolean;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const due = dueLabelOf(todo, dayStart, dayEnd);
  return (
    <button
      type="button"
      onClick={() => onToggle(todo.id)}
      title={todo.done ? `${todo.title || '未命名'}（点击恢复为未完成）` : '点击标记完成'}
      className={cn(
        'group flex min-w-0 items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-left transition hover:bg-white/15',
        fill ? 'w-full' : 'max-w-[220px]',
      )}
    >
      <span
        className={cn(
          'h-3 w-3 shrink-0 rounded-full border transition',
          todo.done
            ? 'border-emerald-400 bg-emerald-400/70'
            : todo.priority >= 3
              ? 'border-red-400 group-hover:border-emerald-400 group-hover:bg-emerald-400/30'
              : todo.priority === 2
                ? 'border-amber-400 group-hover:border-emerald-400 group-hover:bg-emerald-400/30'
                : 'border-neutral-400 group-hover:border-emerald-400 group-hover:bg-emerald-400/30',
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[11px]',
          todo.done ? 'text-neutral-400 line-through' : 'text-neutral-100',
        )}
      >
        {todo.title || '未命名'}
      </span>
      {due !== null ? (
        <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">{due}</span>
      ) : null}
    </button>
  );
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

  /** 展开态（多行清单）；记忆在 localStorage，重启保持 */
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(EXPANDED_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      /* 隐私模式 / 配额满：折叠态不致命，忽略 */
    }
  }, [expanded]);

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

  /** 今天尚未完成的（折叠态只列这些） */
  const todayPending = useMemo(
    () => todayAll.filter((todo) => !todo.done).sort(compareTodos),
    [todayAll],
  );

  /** 今天已完成的（展开态排在后面，穿删除线） */
  const todayDoneList = useMemo(
    () => todayAll.filter((todo) => todo.done).sort(compareTodos),
    [todayAll],
  );

  /** 今天已完成数（进度分母 = todayAll.length） */
  const todayDone = todayDoneList.length;

  const dayWindow = useMemo(() => {
    const dayStart = startOfDay(now);
    return { dayStart, dayEnd: dayStart + DAY_MS };
  }, [now]);

  /** 展开态清单 = 未完成在前 + 已完成在后，超出上限截断 */
  const expandedItems = useMemo(
    () => [...todayPending, ...todayDoneList].slice(0, EXPANDED_LIMIT),
    [todayPending, todayDoneList],
  );

  const expandedOverflow =
    todayPending.length + todayDoneList.length - expandedItems.length;

  const overdueCount = useMemo(() => {
    const dayStart = startOfDay(now);
    return todos.filter((todo) => !todo.done && todo.dueAt !== null && todo.dueAt < dayStart).length;
  }, [todos, now]);

  /**
   * 内容高度 → Rust：量「壳」的高度并去抖后回报。
   *
   * 壳是 auto height，不受窗口高度影响，因此「窗口高 = 内容高」，不会自激。
   * 高度差 < 1px 就不回报，避免 ResizeObserver 抖动里反复改窗口尺寸。
   */
  const measureRef = useRef<HTMLDivElement | null>(null);
  const reportedRef = useRef(0);
  useEffect(() => {
    const node = measureRef.current;
    if (node === null) {
      return undefined;
    }
    let raf = 0;
    const report = (): void => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height <= 0 || Math.abs(height - reportedRef.current) < 1) {
        return;
      }
      reportedRef.current = height;
      void ipc.barSetHeight(height).catch(() => undefined);
    };
    const schedule = (): void => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(report);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, []);

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

  /**
   * 贴条置顶开关（V21，用户反馈 #5）。
   *
   * 「这个贴条可以置顶也可以不置顶，加个图标控制，不然一直置顶当界面也很烦的」——
   * 置顶与「贴条开着没有」是两件事：开着但一直被压在别的窗口之上会挡视线，
   * 关掉后贴条退化成普通窗口，被盖住、切回桌面又露出来。
   *
   * 状态存 `settings.barOnTop`；因为 `show_bar` 建窗时默认置顶，所以本窗挂载
   * 以及每次显隐之后都要按设置纠正一次（主窗口显隐路径见 `main.tsx`）。
   */
  const barOnTop = useAppStore((state) => state.settings.barOnTop);
  useEffect(() => {
    void ipc.barSetPinned(useAppStore.getState().settings.barOnTop).catch(() => undefined);
  }, []);

  /**
   * 贴条与主窗口**各持一份 store** —— 设置中心里改了「贴条始终置顶」，本窗口不会
   * 收到通知，图钉图标就会与实际状态对不上。窗口重新获得焦点时从配置文件补读一次，
   * 顺带把置顶状态纠正到真实值（这是最省的跨窗口同步，不必为此再造一条事件总线）。
   */
  useEffect(() => {
    const resync = (): void => {
      void readSettings()
        .then((settings) => {
          useAppStore.setState((prev) => ({ settings: { ...prev.settings, ...settings } }));
          void ipc.barSetPinned(settings.barOnTop).catch(() => undefined);
        })
        .catch(() => undefined);
    };
    window.addEventListener('focus', resync);
    return () => window.removeEventListener('focus', resync);
  }, []);

  const toggleOnTop = useCallback((): void => {
    const next = !useAppStore.getState().settings.barOnTop;
    void useAppStore.getState().updateSettings({ barOnTop: next }).catch(() => undefined);
    void ipc.barSetPinned(next).catch((error: unknown) => {
      toast.error('切换贴条置顶失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  /** D. 时间 + 计数 + 今日进度（同时是拖拽区） */
  const clockBlock = (
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
  );

  /** 动作区：快速新增 / 展开折叠 / 打开工作台 / 收起贴条 */
  const actions = (
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
        onClick={() => setExpanded((prev) => !prev)}
        title={expanded ? '折叠贴条，只留一行概览' : '展开贴条，看今天所有待办'}
        aria-expanded={expanded}
        className="rounded-md bg-white/10 p-1 transition hover:bg-white/20"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={toggleOnTop}
        title={
          barOnTop
            ? '取消置顶：贴条不再压在所有窗口上（被盖住，回桌面可见）'
            : '置顶贴条：让它始终浮在最上层'
        }
        aria-pressed={barOnTop}
        className={cn(
          'rounded-md p-1 transition',
          barOnTop
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'text-neutral-400 hover:bg-white/20 hover:text-white',
        )}
      >
        {barOnTop ? <Pin className="h-3.5 w-3.5" fill="currentColor" /> : <PinOff className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={openWorkstation}
        title="打开工作台（日历 / 计划 / 便签 / 快捷入口）"
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
  );

  return (
    <div ref={measureRef} className="w-full">
      <div
        className={cn(
          'flex w-full rounded-xl bg-neutral-900/90 text-neutral-100 ring-1 ring-white/10 backdrop-blur-md',
          expanded ? 'flex-col' : 'h-11 flex-row items-center gap-3 px-3',
        )}
      >
        {/* —— 标题行（折叠 / 展开共用） —— */}
        <div
          /* 折叠态用 `display: contents`：本层不生成盒子，四个子块直接成为卡片（row）的 flex 项，
             布局与旧版单行完全一致；展开态才是真正的标题行 */
          className={expanded ? 'flex h-11 shrink-0 items-center gap-3 px-3' : 'contents'}
        >
          {clockBlock}
          <span className="h-5 w-px shrink-0 bg-white/15" />

          {expanded ? (
            /* 展开态：中段让位给「今天几件事」的摘要 + 快速新增输入框 */
            adding ? (
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
            ) : (
              <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
                {todayPending.length === 0
                  ? '今天没有待办 —— 点「＋」随手记一条'
                  : `今日待办 ${todayPending.length} 项${todayDone > 0 ? ` · 已完成 ${todayDone}` : ''}`}
              </span>
            )
          ) : (
            /* 折叠态：单行速览（点击即完成）+ 内联快速新增 */
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
                todayPending.slice(0, COLLAPSED_LIMIT).map((todo: Todo) => (
                  <TodoChip
                    key={todo.id}
                    todo={todo}
                    dayStart={dayWindow.dayStart}
                    dayEnd={dayWindow.dayEnd}
                    fill={false}
                    onToggle={toggle}
                  />
                ))
              )}
              {!adding && todayPending.length > COLLAPSED_LIMIT ? (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  title="展开查看今天全部待办"
                  className="shrink-0 rounded px-1 text-[10px] text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
                >
                  +{todayPending.length - COLLAPSED_LIMIT}
                </button>
              ) : null}
            </div>
          )}

          {actions}
        </div>

        {/* —— 展开态：今日待办多行清单（两列铺开，已完成靠后穿删除线） —— */}
        {expanded ? (
          <div className="px-3 pb-2.5">
            {expandedItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-white/15 px-3 py-3 text-center text-[11px] text-neutral-400">
                今天还没有待办 —— 点上面的「＋」随手记一条
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-1">
                {expandedItems.map((todo: Todo) => (
                  <TodoChip
                    key={todo.id}
                    todo={todo}
                    dayStart={dayWindow.dayStart}
                    dayEnd={dayWindow.dayEnd}
                    fill
                    onToggle={toggle}
                  />
                ))}
              </div>
            )}
            {expandedOverflow > 0 ? (
              <button
                type="button"
                onClick={openWorkstation}
                className="mt-1 w-full rounded-md px-2 py-0.5 text-left text-[10px] text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
              >
                还有 {expandedOverflow} 项没显示 —— 点这里打开工作台看全部
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default WorkstationBar;

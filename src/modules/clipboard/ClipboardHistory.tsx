import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardCopy,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Pin,
  PinOff,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
} from 'lucide-react';
import { useAppStore } from '@/stores/useAppStore';
import { registry } from '@/core/moduleRegistry';
import { openCommand } from '@/core/navigation';
import {
  type ClipItem,
  type ClipsChangedPayload,
  clearClips,
  deleteClip,
  listClips,
  searchClips,
  togglePinClip,
} from '@/core/data/clipboardService';
import { BUS_EVENT_CLIPS_CHANGED, busOn } from '@/core/data/bus';
import { ipc } from '@/lib/ipc';
import { copyText } from '@/lib/clipboard';
import { createNote, openNoteWindow } from '@/core/data/notesService';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import {
  classifyClip,
  matchClipContent,
  type ClipContentKind,
  type ClipMatch,
  SUGGESTED_COMMAND_NAMES,
} from './matchers';

/**
 * 剪贴板历史视图（V11）。
 *
 * 双承载：主面板模块内页（`ModuleView` → `loadView`）与命令视图（「剪贴板历史」命令）复用。
 *
 * 行为：
 *   - 列表倒序 + **置顶优先**；每条 ≤3 行截断摘要 + 类型徽章（matchers 识别）+ 相对时间；
 *   - **点击条目 = 回贴**（写回系统剪贴板，经 Rust `clipboard_write_text`）；敏感条目
 *     默认打码且不自动回贴（V10 起敏感内容本就不落库，此分支为 schema 预留防御）；
 *   - 条目菜单：复制、转为便签、置顶/取消置顶、删除；顶部「清空」二次确认（置顶保留）；
 *   - 搜索走 `clipboardService.searchClips`（FTS5，短语转义在服务层），防抖 300ms；
 *   - 推荐动作：识别命中的工具一键直达（内容预填进目标工具输入框）；
 *   - 一键转便签：`notesService.createNote`（标题 = 类型 + 时间，内容 = 原文）→
 *     `openNoteWindow`；**原剪贴板条目不删**（互转口径与 V08/V09 一致）。
 *
 * 图片类条目仅显示占位卡 +「暂不支持预览」文案（本轮不做真实图片捕获，不伪造缩略图）。
 * 数据全部经 V10 服务层读写（**不新造 SQL**）；跨窗口变更经 `clips:changed` 总线刷新。
 */

/** 单次拉取上限（V11 列表；更大规模的分页留待后续） */
const LIST_LIMIT = 300;

/** 搜索输入防抖（毫秒） */
const SEARCH_DEBOUNCE_MS = 300;

/** 时间展示（MM-DD HH:mm） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间（今天以内相对，更早回退绝对时间） */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 172_800_000) {
    return '昨天';
  }
  return formatTime(ms);
}

/** 内容形态 → 中文标签（转便签标题用） */
function clipKindLabel(form: ClipContentKind): string {
  if (form === 'image') {
    return '图片';
  }
  if (form === 'file-path') {
    return '文件路径';
  }
  return '文本';
}

/** 排序：置顶优先 → 最近创建优先 */
function sortPinnedFirst(items: ClipItem[]): ClipItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.createdAt - a.createdAt;
  });
}

export interface ClipboardHistoryProps {
  /** 兼容 CommandProps（命令视图注入）：作为初始搜索词 */
  initialInput?: string;
  /** 兼容 CommandProps（输入来源，未使用） */
  source?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

/** 剪贴板历史视图（主面板模块内页 / 命令视图复用）。 */
export default function ClipboardHistory({
  initialInput = '',
}: ClipboardHistoryProps = {}): React.JSX.Element {
  const clipboardWatch = useAppStore((state) => state.settings.clipboardWatch);

  const [items, setItems] = useState<ClipItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialInput);
  const [activeQuery, setActiveQuery] = useState(initialInput.trim());
  const [confirmClear, setConfirmClear] = useState(false);

  // 搜索防抖：输入停止 300ms 后才真正查询
  useEffect(() => {
    const timer = window.setTimeout(() => setActiveQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 拉取（空查询 → 全部；非空 → FTS 搜索）
  const load = useCallback(async (): Promise<void> => {
    try {
      const data =
        activeQuery.length > 0
          ? await searchClips(activeQuery, LIST_LIMIT)
          : await listClips(LIST_LIMIT, 0);
      setItems(sortPinnedFirst(data));
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [activeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  // 跨窗口 / 本地变更（监听写入、其它视图增删）→ 刷新
  useEffect(() => {
    return busOn<ClipsChangedPayload>(BUS_EVENT_CLIPS_CHANGED, () => {
      void load();
    });
  }, [load]);

  /** 回贴：历史条目写回系统剪贴板（Rust 命令优先，前端插件兜底）。 */
  const handlePasteBack = async (item: ClipItem): Promise<void> => {
    // 敏感条目不自动回贴（防御：V10 起敏感内容不落库，此分支为 schema 预留）
    if (item.sensitive) {
      toast.error('敏感条目不自动回贴', { description: '请确认内容后再手动复制。' });
      return;
    }
    try {
      await ipc.clipboardWriteText(item.content);
      toast.success('已复制到剪贴板');
    } catch {
      const ok = await copyText(item.content);
      if (ok) {
        toast.success('已复制到剪贴板');
      } else {
        toast.error('回贴失败：无法写入剪贴板');
      }
    }
  };

  const handleTogglePin = async (item: ClipItem): Promise<void> => {
    try {
      await togglePinClip(item.id);
    } catch (err: unknown) {
      toast.error(`置顶操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDelete = async (item: ClipItem): Promise<void> => {
    try {
      await deleteClip(item.id);
    } catch (err: unknown) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleClear = async (): Promise<void> => {
    setConfirmClear(false);
    try {
      const removed = await clearClips();
      toast.success(`已清空 ${removed} 条（置顶条目保留）`);
    } catch (err: unknown) {
      toast.error(`清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleToNote = async (item: ClipItem): Promise<void> => {
    try {
      const form = classifyClip(item.content, item.kind);
      // 标题 = 类型 + 时间；内容 = 原文。互转语义：**保留原剪贴板条目**
      const note = await createNote({
        title: `${clipKindLabel(form)} ${formatTime(item.createdAt)}`,
        body: item.content,
      });
      await openNoteWindow(note.id);
      toast.success('已转为便签（原剪贴板条目保留）');
    } catch (err: unknown) {
      toast.error(`转为便签失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRunAction = (item: ClipItem, match: ClipMatch): void => {
    const commandId = match.suggestedCommandId;
    if (!commandId) {
      return;
    }
    if (!registry.findCommand(commandId)) {
      toast.error('对应工具不可用', { description: '请先在设置中启用相关模块。' });
      return;
    }
    // CommandView 支持 initialInput 预填 → 直接携带内容打开目标工具
    openCommand(commandId, { input: item.content, source: 'clipboard' });
  };

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：搜索 + 清空 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索剪贴板历史"
            className="h-8 w-full rounded-md border bg-transparent pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
          />
        </div>
        {confirmClear ? (
          <>
            <button
              type="button"
              onClick={() => void handleClear()}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-destructive px-3 text-xs font-medium text-white transition hover:bg-destructive/90"
            >
              确认清空
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="h-8 shrink-0 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            title="清空历史（置顶条目保留）"
            onClick={() => setConfirmClear(true)}
            disabled={items.length === 0}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eraser className="h-3.5 w-3.5" />
            清空
          </button>
        )}
      </div>

      {/* 监听关闭提示 */}
      {!clipboardWatch && (
        <div className="mx-4 mb-2 rounded-md border border-amber-300/50 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
          后台监听已关闭：此处仅显示已有历史。可在「设置 → 剪贴板」中开启实时记录。
        </div>
      )}

      {/* 错误态 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          加载剪贴板历史失败：{error}
        </div>
      )}

      {/* 加载 / 空 / 列表 */}
      {!loaded ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          正在加载剪贴板历史…
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <ClipboardCopy className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {activeQuery.length > 0 ? '未找到匹配的剪贴板记录' : '还没有剪贴板历史'}
          </p>
          <p className="text-xs text-muted-foreground/70">
            复制任意文本后会自动记录（敏感内容不留痕）
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            {items.map((item) => (
              <ClipRow
                key={item.id}
                item={item}
                onPasteBack={handlePasteBack}
                onTogglePin={handleTogglePin}
                onDelete={handleDelete}
                onToNote={handleToNote}
                onRunAction={handleRunAction}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ClipRowProps {
  item: ClipItem;
  onPasteBack: (item: ClipItem) => void;
  onTogglePin: (item: ClipItem) => void;
  onDelete: (item: ClipItem) => void;
  onToNote: (item: ClipItem) => void;
  onRunAction: (item: ClipItem, match: ClipMatch) => void;
}

/** 单条历史行（点击回贴 + 类型徽章 + 相对时间 + 推荐动作 + 条目菜单）。 */
function ClipRow({
  item,
  onPasteBack,
  onTogglePin,
  onDelete,
  onToNote,
  onRunAction,
}: ClipRowProps): React.JSX.Element {
  const form = classifyClip(item.content, item.kind);
  const match = useMemo(
    () => (form === 'image' ? null : matchClipContent(item.content)),
    [item.content, form],
  );
  const [revealed, setRevealed] = useState(false);
  const Icon = form === 'image' ? ImageIcon : form === 'file-path' ? FileText : Type;

  /** ≤3 行截断摘要（line-clamp 需要 -webkit-box，Tailwind 插件未装，用内联样式） */
  const clampStyle: React.CSSProperties = {
    display: '-webkit-box',
    WebkitLineClamp: '3',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };

  return (
    <div
      className="group cursor-pointer rounded-lg border border-transparent px-2.5 py-2 transition hover:border-border hover:bg-accent/50"
      onClick={() => onPasteBack(item)}
      title="点击回贴到剪贴板"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          {/* 内容摘要 / 敏感打码 / 图片占位 */}
          {form === 'image' ? (
            <div className="flex h-16 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
              图片内容 · 暂不支持预览
            </div>
          ) : item.sensitive && !revealed ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="tracking-widest">••••••••</span>
              <span className="text-[10px]">敏感内容（已打码）</span>
            </p>
          ) : (
            <p style={clampStyle} className="break-words text-sm text-foreground">
              {item.content}
            </p>
          )}

          {/* 元信息：类型徽章 + 相对时间 + 置顶标记 */}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            {match && (
              <span className="rounded bg-brand-muted px-1.5 py-0.5 font-medium text-brand">
                {match.type === 'file-path' ? '文件路径' : match.type.toUpperCase()}
              </span>
            )}
            <span>{relativeTime(item.createdAt)}</span>
            {item.sourceApp && <span>· {item.sourceApp}</span>}
            {item.pinned && (
              <span className="inline-flex items-center gap-0.5 text-brand">
                <Pin className="h-3 w-3" />
                已置顶
              </span>
            )}
            {item.sensitive && (
              <button
                type="button"
                title={revealed ? '隐藏敏感内容' : '显示敏感内容'}
                onClick={(event) => {
                  event.stopPropagation();
                  setRevealed((v) => !v);
                }}
                className="inline-flex items-center gap-0.5 rounded p-0.5 hover:bg-accent"
              >
                {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                {revealed ? '隐藏' : '显示'}
              </button>
            )}
          </div>

          {/* 推荐动作：识别命中 → 一键直达（内容预填进目标工具） */}
          {match?.suggestedCommandId && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Sparkles className="h-3 w-3 text-brand" />
              <button
                type="button"
                title={match.displayHint ?? ''}
                onClick={(event) => {
                  event.stopPropagation();
                  onRunAction(item, match);
                }}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition hover:bg-brand-muted hover:text-brand"
              >
                用 {SUGGESTED_COMMAND_NAMES[match.suggestedCommandId] ?? '工具'} 打开
              </button>
            </div>
          )}
        </div>

        {/* 条目菜单：复制 / 转便签 / 置顶 / 删除（阻止冒泡，避免触发行回贴） */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            title="复制"
            onClick={(event) => {
              event.stopPropagation();
              onPasteBack(item);
            }}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="转为便签"
            onClick={(event) => {
              event.stopPropagation();
              onToNote(item);
            }}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <StickyNote className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={item.pinned ? '取消置顶' : '置顶'}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(item);
            }}
            className={cn(
              'rounded p-1 transition hover:bg-accent',
              item.pinned ? 'text-brand' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(item);
            }}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

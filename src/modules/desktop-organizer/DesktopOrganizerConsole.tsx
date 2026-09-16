import { useState } from 'react';
import { FolderTree, LayoutGrid } from 'lucide-react';
import OrganizerView from './OrganizerView';
import GridManagerView from '../desktop-grid/GridManagerView';
import { cn } from '@/lib/utils';

/**
 * 桌面整理控制台（V25 新增，模块首屏）。
 *
 * # 为什么要加这一层
 *
 * 用户反馈：「桌面整理还是在自己的框里面玩，没有正式操作系统桌面，
 * 我们的架构是不是没有做到操作系统桌面整理呢？不行就把这个功能砍掉，
 * 否则就完善好」。
 *
 * 查证后的结论是**能力有、入口错**：
 *
 * | 能力 | 实现 | 对文件的影响 |
 * | --- | --- | --- |
 * | 归类文件 | `OrganizerView` + Rust `organizer.rs` | **真移动**到「桌面/Handy整理/类别/」，可撤销 |
 * | 桌面格子 | `GridManagerView` + Rust `grid.rs` | **一个字节都不动**，只登记引用做悬浮层 |
 *
 * 而 V19 之后模块首屏一直指向后者 —— 于是「桌面整理」这个名字下面，
 * 用户看到的是一个只在自己框里摆积木东西的页面，「没有真正操作系统桌面」
 * 这句评价完全成立。
 *
 * # 这一层做的事
 *
 * 一个页签栏，**首屏就是「归类文件」**（默认 tab），把真移动文件那套放到最前面；
 * 「桌面格子」保留为第二页签（它本身是有价值的：格子层是桌面上的悬浮整理层，
 * 且零磁盘风险），但不再冒充主功能。两边各自的语义在页签旁一句话说清。
 */
type ConsoleTab = 'files' | 'grid';

/** 页签定义：图标 + 名称 + 一句话说清「动不动文件」 */
const TABS: ReadonlyArray<{
  id: ConsoleTab;
  label: string;
  hint: string;
  icon: typeof FolderTree;
}> = [
  {
    id: 'files',
    label: '归类文件',
    hint: '真移动：按类型 / 日期把桌面文件归进「桌面/Handy整理/」，可一键撤销',
    icon: FolderTree,
  },
  {
    id: 'grid',
    label: '桌面格子',
    hint: '不移动：只在桌面上叠一层格子，把图标收进去（登记引用）',
    icon: LayoutGrid,
  },
];

export function DesktopOrganizerConsole(): React.JSX.Element {
  const [tab, setTab] = useState<ConsoleTab>('files');
  const current = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 页签栏：顺便把「哪个动文件、哪个不动」写在标签旁边 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition',
                active
                  ? 'bg-brand-muted font-medium text-brand'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
        <span className="ml-2 min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {current?.hint}
        </span>
      </div>

      {/* 视图区：两个视图各自管理内部滚动（都声明了 h-full + overflow） */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'files' ? <OrganizerView /> : <GridManagerView embedded />}
      </div>
    </div>
  );
}

/** 供模块注册表 `loadView` 动态导入 */
export default DesktopOrganizerConsole;

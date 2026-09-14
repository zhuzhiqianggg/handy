import * as React from 'react';
import { ToolGrid } from '@/components/ToolGrid';
import type { ModuleProps } from '@/core/types';

/**
 * 工具箱（M1）面板内页。
 *
 * 经 `ModuleMeta.loadView` 惰性加载（未启用模块不加载其代码，ARCHITECTURE §9）。
 * 内容为工具箱下的子工具网格 + 一句引导文案。
 */
export function ToolboxView({ windowKind }: ModuleProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header>
        <h2 className="text-base font-semibold text-foreground">工具箱</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          常用开发 / 文本工具，也可用快捷键呼出命令面板直接搜索名称或拼音首字母。
        </p>
      </header>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto">
        <ToolGrid moduleId="toolbox" />
      </div>
      {windowKind ? (
        <p className="text-xs text-muted-foreground">承载形态：{windowKind}</p>
      ) : null}
    </div>
  );
}

export default ToolboxView;

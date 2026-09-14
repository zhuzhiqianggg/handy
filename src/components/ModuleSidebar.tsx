import * as React from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { registry } from '@/core/moduleRegistry';
import { openModule, openSettings } from '@/core/navigation';
import { useAppStore } from '@/stores/useAppStore';
import { resolveIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';

export interface ModuleSidebarProps {
  className?: string;
}

/**
 * 模块侧栏（面板内导航）。
 *
 * V04 起改为从 `moduleRegistry.enabled()` 读取启用模块（自动发现，无需改框架）：
 * 新增模块只需新建 `src/modules/<id>/index.ts`，侧栏条目自动出现。
 */
export function ModuleSidebar({ className }: ModuleSidebarProps): React.JSX.Element {
  const view = useAppStore((state) => state.view);
  // 订阅启停映射以驱动启用模块列表重渲染
  const modulesState = useAppStore((state) => state.settings.modules);
  const modules = React.useMemo(() => registry.enabled(), [modulesState]);

  const activeId = view.kind === 'module' ? view.moduleId : undefined;

  return (
    <nav
      aria-label="模块导航"
      className={cn(
        'flex h-full w-14 flex-col items-center gap-1 border-r border-border bg-background py-3',
        className,
      )}
    >
      {modules.map((mod) => {
        const Icon = resolveIcon(mod.icon);
        const active = mod.id === activeId;
        return (
          <Tooltip key={mod.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mod.name}
                aria-current={active ? 'page' : undefined}
                onClick={() => openModule(mod.id)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-brand-muted text-brand',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{mod.name}</TooltipContent>
          </Tooltip>
        );
      })}

      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="设置"
              onClick={openSettings}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

import * as React from 'react';
import { registry } from '@/core/moduleRegistry';
import { openCommand } from '@/core/navigation';
import { resolveIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { CommandMeta } from '@/core/types';

export interface ToolGridProps {
  /** 模块 id（取其下命令） */
  moduleId: string;
  className?: string;
}

interface ToolCardProps {
  command: CommandMeta;
}

function ToolCard({ command }: ToolCardProps): React.JSX.Element {
  const Icon = resolveIcon(command.icon);
  return (
    <button
      type="button"
      onClick={() => openCommand(command.id)}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors',
        'hover:border-brand/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{command.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {command.description}
        </span>
      </span>
    </button>
  );
}

/** 某模块下的工具网格（点击打开命令）。 */
export function ToolGrid({ moduleId, className }: ToolGridProps): React.JSX.Element {
  const commands = React.useMemo(() => registry.commandsOf(moduleId), [moduleId]);

  if (commands.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>该模块暂无可用的工具。</p>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      {commands.map((command) => (
        <ToolCard key={command.id} command={command} />
      ))}
    </div>
  );
}

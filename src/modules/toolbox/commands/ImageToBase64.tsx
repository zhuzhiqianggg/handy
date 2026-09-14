import * as React from 'react';
import { FileImage, Upload } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { toast } from '@/components/ui/toast';
import { readFileAsBase64 } from '@/modules/toolbox/lib/base64Utils';
import { formatBytes } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'image-to-base64';

/**
 * 图片转 Base64：选择本地图片文件，读取字节为 Base64（复用工具箱 base64Utils 的
 * FileReader 实现，Tauri WebView 与浏览器行为一致），并预览、可一键复制。
 */
export function ImageToBase64({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [base64, setBase64] = React.useState<string>('');
  const [preview, setPreview] = React.useState<string>('');
  const [meta, setMeta] = React.useState<{ name: string; size: number; type: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleFile = React.useCallback(async (file: File | undefined): Promise<void> => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.warning('请选择图片文件（png/jpg/gif/webp 等）');
      return;
    }
    try {
      const encoded = await readFileAsBase64(file);
      setBase64(encoded);
      setPreview(`data:${file.type};base64,${encoded}`);
      setMeta({ name: file.name, size: file.size, type: file.type });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '读取失败';
      toast.error(`图片读取失败：${message}`);
    }
  }, []);

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      event.target.value = '';
      void handleFile(file);
    },
    [handleFile],
  );

  return (
    <CommandShell
      title="图片转 Base64"
      description="选择图片，读取字节为 Base64 并预览"
      icon={<FileImage className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={base64}
      shortcutHint="点击「选择图片」后即时生成可复制的 Base64"
    >
      <div className="flex flex-col gap-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleChange}
        />
        <Button variant="outline" size="sm" className="self-start" onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" />
          选择图片
        </Button>

        {meta ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>文件名：{meta.name}</span>
            <span>类型：{meta.type}</span>
            <span>大小：{formatBytes(meta.size)}</span>
            <span>Base64 长度：{base64.length}</span>
          </div>
        ) : null}

        {preview ? (
          <div className="flex justify-center rounded-md border border-border bg-card p-3">
            {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
            <img src={preview} alt="预览" className="max-h-48 rounded object-contain" />
          </div>
        ) : null}

        <ResultBox
          title="Base64"
          value={base64}
          emptyHint="选择图片后显示其 Base64 编码"
          mono
        />
      </div>
    </CommandShell>
  );
}

export default ImageToBase64;

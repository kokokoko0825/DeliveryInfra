import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { PROGRAM_SIZE } from '../engine/layout';

function Monitor({ label, canvas, program, running }: { label: string; canvas: RefObject<HTMLCanvasElement | null>; program?: boolean; running: boolean }) {
  return (
    <figure className="space-y-2">
      <figcaption className={cn('text-sm font-semibold', program ? 'text-primary' : 'text-muted-foreground')}>{label}</figcaption>
      <div className={cn('relative overflow-hidden rounded-lg border bg-muted', program ? 'border-primary' : 'border-border')}>
        <canvas ref={canvas} width={PROGRAM_SIZE.width} height={PROGRAM_SIZE.height} aria-label={label} className="block aspect-video w-full" />
        {!running && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">未起動</p>}
      </div>
    </figure>
  );
}

export function Monitors({ preview, program, running }: { preview: RefObject<HTMLCanvasElement | null>; program: RefObject<HTMLCanvasElement | null>; running: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Monitor label="プレビュー（PVW）" canvas={preview} running={running} />
      <Monitor label="プログラム（PGM）" canvas={program} program running={running} />
    </div>
  );
}

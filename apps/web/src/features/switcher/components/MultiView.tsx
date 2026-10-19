import { useEffect, useRef, type MouseEvent } from 'react';
import { Image as ImageIcon, MonitorUp, Video, VideoOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SLIDE, STANDBY, cameraSource, sourceLabel, type SourceId } from '../engine/scene';
import { HEALTH_LABEL, type SourceHealth } from '../engine/sources';

export type Tile = { source: SourceId | null; key: string; label: string; health: SourceHealth; stream: MediaStream | null };

/** マウス操作でボタンにフォーカスを移さない（Space/Enter をショートカットに使うため）。 */
export const keepFocus = (event: MouseEvent) => event.preventDefault();

function TileVideo({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className="size-full object-cover" autoPlay muted playsInline />;
}

export function buildTiles(slots: (string | null)[], health: Map<SourceId, SourceHealth>, streamOf: (source: SourceId) => MediaStream | null): Tile[] {
  const tile = (source: SourceId | null, key: string, label: string, fallback: SourceHealth): Tile => ({
    source, key, label, health: source ? health.get(source) ?? fallback : 'disconnected', stream: source ? streamOf(source) : null,
  });
  return [
    ...slots.map((name, index) => tile(name ? cameraSource(name) : null, String(index + 1), name ?? `カメラ ${index + 1}`, name ? 'stalled' : 'disconnected')),
    tile(SLIDE, '7', sourceLabel(SLIDE), 'disconnected'),
    { source: STANDBY, key: '8', label: sourceLabel(STANDBY), health: 'live', stream: null },
  ];
}

const healthIcon = (tile: Tile) => {
  if (tile.source === STANDBY) return <ImageIcon aria-hidden className="size-4" />;
  if (tile.source === SLIDE) return <MonitorUp aria-hidden className="size-4" />;
  return tile.health === 'live' ? <Video aria-hidden className="size-4" /> : <VideoOff aria-hidden className="size-4" />;
};

export function MultiView({ tiles, preview, onAir, standbyUrl, onSelect }: {
  tiles: Tile[]; preview: SourceId; onAir: Set<SourceId>; standbyUrl: string | null; onSelect: (source: SourceId) => void;
}) {
  return (
    <section aria-label="マルチビュー" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => {
        const live = tile.source !== null && onAir.has(tile.source);
        const selected = tile.source === preview;
        return (
          <button
            key={tile.key}
            type="button"
            disabled={tile.source === null}
            onMouseDown={keepFocus}
            onClick={() => tile.source && onSelect(tile.source)}
            aria-pressed={selected}
            aria-label={`${tile.key}: ${tile.label}（${tile.source === STANDBY ? '静止画' : HEALTH_LABEL[tile.health]}）${live ? ' 番組出力中' : ''}`}
            className={cn('group relative overflow-hidden rounded-lg border border-border bg-card text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              selected && 'ring-2 ring-foreground/60', live && 'ring-2 ring-primary')}
          >
            <div className="aspect-video bg-muted">
              {tile.source === STANDBY
                ? standbyUrl ? <img src={standbyUrl} alt="" className="size-full object-cover" /> : <p className="grid size-full place-items-center text-xs text-muted-foreground">既定の待機画面</p>
                : tile.stream && tile.health !== 'disconnected' ? <TileVideo stream={tile.stream} /> : null}
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <kbd className="rounded border border-border px-1.5 text-xs text-muted-foreground">{tile.key}</kbd>
                <span className="truncate font-medium">{tile.label}</span>
              </span>
              <span className={cn('flex shrink-0 items-center gap-1 text-xs', tile.health === 'live' || tile.source === STANDBY ? 'text-muted-foreground' : 'text-destructive')}>
                {healthIcon(tile)}
                {tile.source !== STANDBY && HEALTH_LABEL[tile.health]}
              </span>
            </div>
            {(live || selected) && (
              <Badge variant={live ? 'default' : 'secondary'} className="absolute top-2 left-2">{live ? 'PGM' : 'PVW'}</Badge>
            )}
          </button>
        );
      })}
    </section>
  );
}

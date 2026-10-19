import type { Dispatch } from 'react';
import { SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import { channelOf, micChannel, SLIDE_CHANNEL, VOLUME_MAX, VOLUME_MIN, type Channel, type MixerAction, type MixerState } from '../engine/mixer';

function ChannelStrip({ label, channel, level, connected, onVolume, onMute }: {
  label: string; channel: Channel; level: number; connected: boolean; onVolume: (volume: number) => void; onMute: (muted: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{connected ? `${channel.volume}` : '未接続'}</p>
      </div>
      <div className="space-y-2">
        <Progress aria-label={`${label} のレベル`} value={channel.muted ? 0 : level} className={cn('h-1.5', (channel.muted || !connected) && 'opacity-40')} />
        <Slider aria-label={`${label} の音量`} min={VOLUME_MIN} max={VOLUME_MAX} step={1} value={[channel.volume]}
          onValueChange={([value]) => value !== undefined && onVolume(value)} />
      </div>
      <Toggle aria-label={`${label} をミュート`} pressed={channel.muted} onPressedChange={onMute} variant="outline" className="size-11">
        {channel.muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
      </Toggle>
    </div>
  );
}

export function MixerPanel({ state, dispatch, micNames, connected, levels }: {
  state: MixerState; dispatch: Dispatch<MixerAction>; micNames: string[]; connected: Set<string>; levels: { channels: Map<string, number>; master: number };
}) {
  const channels = [...micNames.map((name) => ({ id: micChannel(name), label: name })), { id: SLIDE_CHANNEL, label: 'PC音声' }];
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4"><CardTitle className="flex items-center gap-2 text-base"><SlidersHorizontal aria-hidden className="size-4" />音声ミキサー</CardTitle></CardHeader>
      <CardContent className="space-y-4 px-4">
        {micNames.length === 0 && <p className="text-sm text-muted-foreground">マイクは接続されていません。</p>}
        {channels.map(({ id, label }) => (
          <ChannelStrip key={id} label={label} channel={channelOf(state, id)} level={levels.channels.get(id) ?? 0} connected={connected.has(id)}
            onVolume={(volume) => dispatch({ type: 'SET_VOLUME', channel: id, volume })}
            onMute={(muted) => dispatch({ type: 'SET_MUTED', channel: id, muted })} />
        ))}
        <div className="border-t border-border pt-4">
          <ChannelStrip label="全体" channel={state.master} level={levels.master} connected
            onVolume={(volume) => dispatch({ type: 'SET_MASTER_VOLUME', volume })}
            onMute={(muted) => dispatch({ type: 'SET_MASTER_MUTED', muted })} />
        </div>
      </CardContent>
    </Card>
  );
}

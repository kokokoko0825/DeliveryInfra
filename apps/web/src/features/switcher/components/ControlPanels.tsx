import { useId, type ChangeEvent, type Dispatch } from 'react';
import { ArrowRightLeft, ImageUp, PictureInPicture2, RotateCcw, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CORNERS, PIP_SIZES, type Corner, type PipSize } from '../engine/layout';
import { sourceLabel, type SourceId } from '../engine/scene';
import type { SwitcherAction, SwitcherState } from '../engine/state';
import { TRANSITION_LABEL, TRANSITION_MAX_SEC, TRANSITION_MIN_SEC, TRANSITION_TYPES, type TransitionType } from '../engine/transition';
import { keepFocus } from './MultiView';

const CORNER_LABEL: Record<Corner, string> = { 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下' };
const SIZE_LABEL: Record<PipSize, string> = { small: '小', medium: '中', large: '大' };

export function TransitionPanel({ state, dispatch }: { state: SwitcherState; dispatch: Dispatch<SwitcherAction> }) {
  const durationId = useId();
  return (
    <Card className="gap-4 py-4">
      <CardContent className="flex flex-col gap-4 px-4 lg:flex-row lg:items-end">
        <div className="space-y-2">
          <Label id={`${durationId}-type`}>切替効果</Label>
          <ToggleGroup type="single" variant="outline" aria-labelledby={`${durationId}-type`} value={state.transitionType}
            onValueChange={(value) => value && dispatch({ type: 'SET_TRANSITION_TYPE', transitionType: value as TransitionType })}>
            {TRANSITION_TYPES.map((type) => <ToggleGroupItem key={type} value={type} className="h-11 px-4">{TRANSITION_LABEL[type]}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <div className="min-w-48 flex-1 space-y-3">
          <div className="flex justify-between text-sm">
            <Label htmlFor={durationId}>時間</Label>
            <span className="tabular-nums text-muted-foreground">{state.durationSec.toFixed(1)} 秒</span>
          </div>
          <Slider id={durationId} aria-label="トランジション時間" min={TRANSITION_MIN_SEC} max={TRANSITION_MAX_SEC} step={0.1}
            value={[state.durationSec]} disabled={state.transitionType === 'cut'}
            onValueChange={([value]) => value !== undefined && dispatch({ type: 'SET_DURATION', seconds: Math.round(value * 10) / 10 })} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="h-11 flex-1 lg:flex-none" onMouseDown={keepFocus} onClick={() => dispatch({ type: 'CUT' })}>
            <Scissors aria-hidden />カット<kbd className="text-xs text-muted-foreground">Space</kbd>
          </Button>
          <Button className="h-11 flex-1 lg:flex-none" onMouseDown={keepFocus} disabled={state.active !== null}
            onClick={() => dispatch({ type: 'AUTO', now: performance.now() })}>
            <ArrowRightLeft aria-hidden />トランジション<kbd className="text-xs opacity-80">Enter</kbd>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PipPanel({ state, dispatch, sources }: { state: SwitcherState; dispatch: Dispatch<SwitcherAction>; sources: SourceId[] }) {
  const id = useId();
  const pip = state.preview.pip;
  const candidates = sources.filter((source) => source !== state.preview.main);
  const update = (patch: Partial<NonNullable<typeof pip>>) => {
    const base = pip ?? (candidates[0] ? { sub: candidates[0], corner: 'bottom-right' as Corner, size: 'medium' as PipSize } : null);
    if (base) dispatch({ type: 'SET_PIP', pip: { ...base, ...patch } });
  };
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between text-base">
          <Label htmlFor={`${id}-on`} className="gap-2"><PictureInPicture2 aria-hidden className="size-4" />PiP（プレビューに適用）</Label>
          <Switch id={`${id}-on`} checked={pip !== null} disabled={!pip && candidates.length === 0}
            onCheckedChange={(checked) => (checked ? update({}) : dispatch({ type: 'SET_PIP', pip: null }))} />
        </CardTitle>
      </CardHeader>
      {pip && (
        <CardContent className="space-y-4 px-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-sub`}>サブ画面</Label>
            <Select value={pip.sub} onValueChange={(value) => update({ sub: value as SourceId })}>
              <SelectTrigger id={`${id}-sub`} className="h-11 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{candidates.map((source) => <SelectItem key={source} value={source}>{sourceLabel(source)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label id={`${id}-corner`}>位置</Label>
            <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-corner`} value={pip.corner} className="grid w-full grid-cols-4"
              onValueChange={(value) => value && update({ corner: value as Corner })}>
              {CORNERS.map((corner) => <ToggleGroupItem key={corner} value={corner} className="h-11">{CORNER_LABEL[corner]}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
          <div className="space-y-2">
            <Label id={`${id}-size`}>大きさ</Label>
            <ToggleGroup type="single" variant="outline" aria-labelledby={`${id}-size`} value={pip.size} className="grid w-full grid-cols-3"
              onValueChange={(value) => value && update({ size: value as PipSize })}>
              {PIP_SIZES.map((size) => <ToggleGroupItem key={size} value={size} className="h-11">{SIZE_LABEL[size]}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function StandbyPanel({ custom, error, onFile, onReset }: { custom: boolean; error: string | null; onFile: (file: File) => void; onReset: () => void }) {
  const id = useId();
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = '';
  };
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4"><CardTitle className="flex items-center gap-2 text-base"><ImageUp aria-hidden className="size-4" />待機画面</CardTitle></CardHeader>
      <CardContent className="space-y-3 px-4">
        <Label htmlFor={id} className="text-muted-foreground">静止画（PNG / JPEG）</Label>
        <Input id={id} type="file" accept="image/png,image/jpeg,image/webp" onChange={change} className="h-11" />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {custom && <Button variant="ghost" className="h-11" onClick={onReset}><RotateCcw aria-hidden />既定の画像に戻す</Button>}
      </CardContent>
    </Card>
  );
}

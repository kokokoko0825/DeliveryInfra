import { memo, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Keyboard, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PageHeader } from '@/components/app/PageHeader';
import { CommentPanel, useAdminModeration } from '@/features/viewer/CommentPanel';
import { BroadcastPanel } from './components/BroadcastPanel';
import { PipPanel, StandbyPanel, TransitionPanel } from './components/ControlPanels';
import { MixerPanel } from './components/MixerPanel';
import { Monitors } from './components/Monitors';
import { MultiView, buildTiles } from './components/MultiView';
import { PreflightPanel } from './components/PreflightPanel';
import { PROGRAM_SIZE } from './engine/layout';
import { SLIDE, STANDBY, cameraSource, type SourceId } from './engine/scene';
import { INTERACTIVE_SELECTOR, SHORTCUT_HELP, keyToAction, shouldIgnoreKey } from './engine/shortcuts';
import { cameraSlots, slideAlert } from './engine/sources';
import { onAirSources } from './engine/state';
import { createDefaultStandby, loadStandbyImage } from './media/compositor';
import { useSwitcher } from './useSwitcher';

const STAGE_LABEL = { production: '制作用', slide: 'スライド用', broadcast: '配信用' } as const;
const STATUS_LABEL = { idle: '未接続', connecting: '接続中', connected: '接続済み', reconnecting: '再接続中' } as const;

/** F-SHR-07: 共有が途切れたら警告。一度受信してから live でなくなった場合のみ。 */
function useSlideAlert(health: ReturnType<typeof useSwitcher>['health']) {
  const [state, setState] = useState({ seen: false, alert: false });
  const current = health.get(SLIDE) ?? 'disconnected';
  useEffect(() => setState((previous) => slideAlert(previous.seen, current)), [current]);
  return state.alert;
}

/** コメント欄（最大100件）は重いので、スイッチング操作による再描画から切り離す（R3-10）。 */
const SwitcherComments = memo(function SwitcherComments() {
  return <CommentPanel className="h-[28rem]" moderation={useAdminModeration()} />;
});

export default function SwitcherPage() {
  const controller = useSwitcher();
  const { switcher, dispatch, routed, health, running, setStandbyImage } = controller;
  const [standbyUrl, setStandbyUrl] = useState<string | null>(null);
  const [standbyError, setStandbyError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const slots = useMemo(() => cameraSlots(routed.cameraNames), [routed.cameraNames]);
  const tiles = buildTiles(slots, health, (source) => controller.registry.stream(source));
  const onAir = onAirSources(switcher);
  const slideLost = useSlideAlert(health);
  const sources: SourceId[] = [...routed.cameraNames.map(cameraSource), SLIDE, STANDBY];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target instanceof HTMLElement ? (event.target.closest<HTMLElement>(INTERACTIVE_SELECTOR) ?? event.target) : null;
      const target = element ? { tagName: element.tagName, isContentEditable: element.isContentEditable, role: element.getAttribute('role') } : null;
      if (shouldIgnoreKey(event.key, target, { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey })) return;
      const action = keyToAction(event.key, slots);
      if (!action) return;
      event.preventDefault();
      dispatch(action.type === 'AUTO' ? { type: 'AUTO', now: performance.now() } : action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, slots]);

  useEffect(() => () => { if (standbyUrl) URL.revokeObjectURL(standbyUrl); }, [standbyUrl]);
  const chooseStandby = async (file: File) => {
    try {
      const image = await loadStandbyImage(file);
      setStandbyImage(image);
      setStandbyUrl(image.src);
      setStandbyError(null);
    } catch (error) {
      setStandbyError(error instanceof Error ? error.message : '画像を読み込めませんでした');
    }
  };
  const resetStandby = () => {
    setStandbyImage(createDefaultStandby(PROGRAM_SIZE));
    setStandbyUrl(null);
  };
  const start = async () => {
    try {
      setStartError(null);
      await controller.start();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'スイッチャーを起動できませんでした');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="スイッチング"
        description="カメラとスライドを切り替えて番組映像を作り、配信します。"
        actions={running ? (
          <ul className="flex flex-wrap gap-3 text-sm text-muted-foreground" aria-label="ステージの接続状態">
            {(Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[]).map((stage) => (
              <li key={stage}>{STAGE_LABEL[stage]}: <span className={controller.statuses[stage] === 'reconnecting' ? 'text-destructive' : 'text-foreground'}>{STATUS_LABEL[controller.statuses[stage]]}</span></li>
            ))}
          </ul>
        ) : (
          <Button className="h-11" onClick={() => void start()}><Power aria-hidden />スイッチャーを起動</Button>
        )}
      />
      {startError && <p role="alert" className="text-sm text-destructive">{startError}</p>}
      {slideLost && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertDescription>スライド共有が途切れています。カメラか待機画面に切り替えてください（共有側で再共有が必要です）。</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Monitors preview={controller.previewCanvas} program={controller.programCanvas} running={running} />
          <TransitionPanel state={switcher} dispatch={dispatch} />
          <MultiView tiles={tiles} preview={switcher.preview.main} onAir={onAir} standbyUrl={standbyUrl} onSelect={(source) => dispatch({ type: 'SELECT_PREVIEW', source })} />
          <details className="text-sm text-muted-foreground">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2"><Keyboard aria-hidden className="size-4" />キーボードショートカット</summary>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pb-2">
              {SHORTCUT_HELP.map(([key, label]) => [<dt key={`${key}-k`}><kbd>{key}</kbd></dt>, <dd key={`${key}-v`}>{label}</dd>])}
            </dl>
          </details>
        </div>
        <aside className="space-y-4">
          <BroadcastPanel running={running} publishing={controller.publishing} bitrate={controller.bitrate}
            startPublishing={controller.startPublishing} stopPublishing={controller.stopPublishing} />
          <MixerPanel state={controller.mixer} dispatch={controller.mixerDispatch} micNames={routed.micNames} connected={new Set(routed.audio.keys())} readLevels={controller.readLevels} running={running} />
          <PipPanel state={switcher} dispatch={dispatch} sources={sources} />
          <StandbyPanel custom={standbyUrl !== null} error={standbyError} onFile={(file) => void chooseStandby(file)} onReset={resetStandby} />
          <PreflightPanel />
          <SwitcherComments />
        </aside>
      </div>
    </div>
  );
}

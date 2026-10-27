import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ConnectionStatus, DeviceNameSelect, ErrorNotice, LevelMeter, SenderErrorNotice, SenderShell } from './components';
import { validateDeviceName } from './engine/deviceName';
import { AUDIO_PUBLISH, micConstraints, toPublishTracks } from './engine/media';
import { canStart, classifyError, isActive, type SenderErrorKind } from './engine/session';
import { createMicAudioGraph, prepareMicAudio, type MicAudioGraph, type PreparedMicAudio } from './micAudioGraph';
import { useDeviceName } from './useDeviceName';
import { useStageSender } from './useStageSender';
import { startVenueMic, type VenueSession, type VenueSessionMetrics } from '@/features/venue/venueAudio';
import { metricsValues, VenueRunControls } from '@/features/venue/VenueMicPage';
import { appendVenueRunRecord, createVenueRun, endVenueRun, type VenueRunRecord } from '@/features/venue/venueRunLog';
import { venueTrialId } from '@/features/venue/venueTrial';
import { recordClientDiagnostic, recordClientEvent } from '@/lib/diagnostics';

const captureProcessingStatus = (settings: MediaTrackSettings | null) => {
  if (!settings) return 'マイクの音声処理設定を確認できません';
  const flags = [settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl];
  if (flags.every((value) => value === false)) return 'マイクの音声処理をオフで取得しました';
  if (flags.some((value) => value === true)) return 'マイク側の音声処理が有効な可能性があります';
  return 'マイクの音声処理設定を確認できません';
};
const isTrackEnded = (track: MediaStreamTrack) => track.readyState === 'ended';

type ActiveVenueRun = { id: string; startedAt: number; created: Promise<boolean>; queue: Promise<void> };
const newRunId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const runRecord = <T extends VenueRunRecord>(type: T['type'], elapsedMs: number, fields: Omit<T, 'type' | 'id' | 'atUtc' | 'elapsedMs'>): T =>
  ({ type, id: `${type}-${Date.now()}-${Math.random()}`, atUtc: new Date().toISOString(), elapsedMs, ...fields }) as T;

export default function MicSendPage() {
  const sender = useStageSender('mic');
  const { options, deviceName, setDeviceName } = useDeviceName('mic');
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [audioGraph, setAudioGraph] = useState<MicAudioGraph | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState<SenderErrorKind | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [venueEnabled, setVenueEnabled] = useState(false);
  const [venueStatus, setVenueStatus] = useState('停止');
  const [runIdValue, setRunIdValue] = useState<string | null>(null);
  const [venueMetrics, setVenueMetrics] = useState<VenueSessionMetrics | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const captureSettings = useRef<MediaTrackSettings | null>(null);
  const prepared = useRef<PreparedMicAudio | null>(null);
  const graph = useRef<MicAudioGraph | null>(null);
  const openingMic = useRef<Promise<MicAudioGraph | null> | null>(null);
  const venue = useRef<VenueSession | null>(null);
  const removeTrackEnded = useRef<(() => void) | null>(null);
  const stopStage = useRef(sender.stop);
  stopStage.current = sender.stop;
  const venueRun = useRef<ActiveVenueRun | null>(null);
  const runSampler = useRef<ReturnType<typeof setInterval> | null>(null);
  const venueGeneration = useRef(0);
  const mutedRef = useRef(false);
  const disposed = useRef(false);

  const appendRun = (run: ActiveVenueRun, item: VenueRunRecord) => {
    run.queue = run.queue.then(async () => { if (await run.created) await appendVenueRunRecord(run.id, item); }).catch((error: unknown) => {
      recordClientDiagnostic(error, 'venue.run-log.write', { runId: run.id, type: item.type, side: 'mic' });
      if (!disposed.current) setAudioError('会場の計測ログを保存できませんでした。ブラウザのサイトデータ設定を確認してください。');
    });
  };
  const stopRun = (reason: string) => {
    if (runSampler.current) clearInterval(runSampler.current);
    runSampler.current = null;
    const run = venueRun.current;
    venueRun.current = null;
    if (!run) return;
    appendRun(run, runRecord('transport', performance.now() - run.startedAt, { event: 'stop', detail: reason }));
    run.queue = run.queue.then(async () => { if (await run.created) await endVenueRun(run.id, new Date().toISOString()); }).catch((error: unknown) => {
      recordClientDiagnostic(error, 'venue.run-log.end', { runId: run.id, side: 'mic' });
    });
  };

  useEffect(() => {
    if (!audioGraph) return;
    const timer = setInterval(() => setLevel(audioGraph.level()), 100);
    return () => { clearInterval(timer); setLevel(0); };
  }, [audioGraph]);

  useEffect(() => {
    if (!audioGraph) return;
    const context = audioGraph.context;
    const update = () => {
      const interrupted = context.state === 'suspended' || context.state === 'interrupted';
      setAudioInterrupted(interrupted);
      if (interrupted) recordClientDiagnostic(new Error('AudioContext が停止しました'), 'media.microphone.audio-context-state', { state: context.state });
    };
    context.addEventListener?.('statechange', update);
    update();
    return () => context.removeEventListener?.('statechange', update);
  }, [audioGraph]);

  /** The first resume call happens synchronously inside the user's click. */
  const openMic = useCallback((): Promise<MicAudioGraph | null> => {
    try {
      prepared.current = prepareMicAudio(prepared.current ?? undefined);
    } catch (error) {
      recordClientDiagnostic(error, 'media.microphone.audio-context');
      setAudioError('音声処理を開始できません。ブラウザの音声設定を確認してください。');
      return Promise.resolve(null);
    }
    if (graph.current) {
      return prepared.current.ready.then(() => {
        if (graph.current?.context.state !== 'running') throw new Error('音声処理が停止しています');
        return graph.current;
      }).catch((error: unknown) => {
        recordClientDiagnostic(error, 'media.microphone.audio-context-resume');
        setAudioError('音声処理を再開できません。画面上の再開ボタンを押してください。');
        return null;
      });
    }
    if (openingMic.current) return openingMic.current;

    const currentPrepared = prepared.current;
    const request = (async () => {
      const media = await navigator.mediaDevices.getUserMedia(micConstraints());
      if (disposed.current) { media.getTracks().forEach((item) => item.stop()); return null; }
      stream.current = media;
      const sourceTrack = media.getAudioTracks()[0];
      if (!sourceTrack) throw new Error('マイク入力がありません');
      if (isTrackEnded(sourceTrack)) throw new Error('マイク入力が切断されました');
      sourceTrack.enabled = !mutedRef.current;
      const nextGraph = await createMicAudioGraph(sourceTrack, currentPrepared);
      if (disposed.current) { nextGraph.close(); media.getTracks().forEach((item) => item.stop()); return null; }
      if (isTrackEnded(sourceTrack)) { nextGraph.close(); throw new Error('マイク入力が切断されました'); }
      graph.current = nextGraph;
      const onEnded = () => {
        if (disposed.current || stream.current !== media) return;
        recordClientDiagnostic(new Error('マイク入力が切断されました'), 'media.microphone.track-ended');
        venueGeneration.current += 1;
        venue.current?.close();
        venue.current = null;
        stopRun('microphone-ended');
        stopStage.current();
        removeTrackEnded.current?.();
        removeTrackEnded.current = null;
        graph.current?.close();
        graph.current = null;
        prepared.current = null;
        stream.current?.getTracks().forEach((item) => item.stop());
        stream.current = null;
        setTrack(null);
        setAudioGraph(null);
        setVenueEnabled(false);
        setVenueStatus('マイク入力が切断されました');
        setVenueMetrics(null);
        setAudioError('マイク入力が切断されました。端末を確認して再度開始してください。');
      };
      sourceTrack.addEventListener('ended', onEnded, { once: true });
      removeTrackEnded.current = () => sourceTrack.removeEventListener('ended', onEnded);
      setTrack(sourceTrack);
      setAudioGraph(nextGraph);
      setMediaError(null);
      setAudioError(null);
      let settings: MediaTrackSettings | null = null;
      try { settings = sourceTrack.getSettings?.() ?? null; }
      catch (error) { recordClientDiagnostic(error, 'media.microphone.get-settings'); }
      const status = captureProcessingStatus(settings);
      captureSettings.current = settings;
      setProcessingStatus(status);
      let supported: MediaTrackSupportedConstraints | null = null;
      try { supported = navigator.mediaDevices.getSupportedConstraints?.() ?? null; }
      catch (error) { recordClientDiagnostic(error, 'media.microphone.get-supported-constraints'); }
      recordClientEvent('media.microphone.capture-settings', status, {
        echoCancellation: settings?.echoCancellation ?? null,
        noiseSuppression: settings?.noiseSuppression ?? null,
        autoGainControl: settings?.autoGainControl ?? null,
        sampleRate: settings?.sampleRate ?? null,
        channelCount: settings?.channelCount ?? null,
        supportsEchoCancellation: supported?.echoCancellation ?? null,
        supportsNoiseSuppression: supported?.noiseSuppression ?? null,
        supportsAutoGainControl: supported?.autoGainControl ?? null,
      });
      if (nextGraph.dspMode === 'bypass') recordClientDiagnostic(new Error('配信用音声処理をバイパスしました'), 'media.microphone.dsp-bypass');
      return nextGraph;
    })().catch((error) => {
      recordClientDiagnostic(error, 'media.microphone.capture');
      const kind = classifyError(error);
      if (kind === 'permission' || kind === 'notFound' || kind === 'busy') setMediaError(kind);
      else setAudioError(error instanceof Error ? error.message : 'マイクを準備できませんでした');
      stream.current?.getTracks().forEach((item) => item.stop());
      stream.current = null;
      void currentPrepared.context.close();
      if (prepared.current?.context === currentPrepared.context) prepared.current = null;
      return null;
    }).finally(() => { if (openingMic.current === request) openingMic.current = null; });
    openingMic.current = request;
    return request;
  }, []);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      venueGeneration.current += 1;
      venue.current?.close();
      venue.current = null;
      stopRun('page-unmount');
      removeTrackEnded.current?.();
      removeTrackEnded.current = null;
      graph.current?.close();
      if (!graph.current && prepared.current) void prepared.current.context.close();
      graph.current = null;
      prepared.current = null;
      stream.current?.getTracks().forEach((item) => item.stop());
      stream.current = null;
    };
  }, []);

  const toggleVenue = async (enabled: boolean) => {
    const generation = ++venueGeneration.current;
    if (!enabled) {
      venue.current?.close();
      venue.current = null;
      stopRun('switch-off');
      setVenueEnabled(false);
      setVenueStatus('停止');
      setVenueMetrics(null);
      recordClientEvent('venue.mic-send.stop', '会場への送信を停止しました');
      return;
    }
    setVenueEnabled(true);
    setVenueStatus('マイクを準備中');
    const audio = await openMic();
    if (generation !== venueGeneration.current) return;
    if (!audio || !stream.current) {
      setVenueEnabled(false);
      setVenueStatus('マイクを準備できませんでした');
      return;
    }
    setVenueStatus('接続待ち');
    const id = newRunId();
    const trialId = venueTrialId();
    const run: ActiveVenueRun = {
      id, startedAt: performance.now(),
      created: createVenueRun({
        id, startedAtUtc: new Date().toISOString(), userAgent: navigator.userAgent,
        peers: [
          'config.transport=pcm', 'config.route=web-audio', `config.dsp=${audio.dspMode}`,
          `config.capture.echoCancellation=${captureSettings.current?.echoCancellation ?? 'unknown'}`,
          `config.capture.noiseSuppression=${captureSettings.current?.noiseSuppression ?? 'unknown'}`,
          `config.capture.autoGainControl=${captureSettings.current?.autoGainControl ?? 'unknown'}`,
          ...(trialId ? [`config.trialId=${trialId}`] : []),
        ],
      }).then(() => true).catch((error: unknown) => {
        recordClientDiagnostic(error, 'venue.run-log.create', { runId: id, side: 'mic' });
        if (!disposed.current) setAudioError('会場の計測ログを保存できませんでした。ブラウザのサイトデータ設定を確認してください。');
        return false;
      }),
      queue: Promise.resolve(),
    };
    venueRun.current = run;
    setRunIdValue(id);
    appendRun(run, runRecord('transport', 0, { event: 'start', detail: 'DataChannel PCM; Web Audio raw branch' }));
    try {
      const session = await startVenueMic(stream.current, { onLeaseLost: () => {
        if (generation !== venueGeneration.current) return;
        venueGeneration.current += 1;
        recordClientDiagnostic(new Error('会場接続の参加登録が失効しました'), 'venue.mic-send.lease-lost', { runId: id });
        appendRun(run, runRecord('error', performance.now() - run.startedAt, { code: 'lease-lost', message: '会場接続の参加登録が失効しました' }));
        venue.current = null;
        stopRun('lease-lost');
        setVenueEnabled(false);
        setVenueStatus('会場接続が終了しました。再度開始してください。');
        setVenueMetrics(null);
      } }, { context: audio.context, ready: audio.ready, source: audio.source, ownsContext: false });
      if (generation !== venueGeneration.current) { session.close(); return; }
      venue.current = session;
      const sample = () => {
        if (venue.current !== session || venueRun.current !== run) return;
        try {
          const metrics = session.getMetrics();
          setVenueMetrics(metrics);
          appendRun(run, runRecord('health', performance.now() - run.startedAt, { values: metricsValues(metrics) }));
        } catch (error) {
          recordClientDiagnostic(error, 'venue.mic-send.metrics', { runId: id });
        }
      };
      sample();
      runSampler.current = setInterval(sample, 1000);
      await session.connected;
      if (generation === venueGeneration.current) {
        setVenueStatus('接続中（DataChannel PCM）');
        appendRun(run, runRecord('transport', performance.now() - run.startedAt, { event: 'connected' }));
        recordClientEvent('venue.mic-send.connected', '会場への送信を開始しました');
      }
    } catch (error) {
      if (generation !== venueGeneration.current) return;
      recordClientDiagnostic(error, 'venue.mic-send.start');
      if (generation === venueGeneration.current) {
        appendRun(run, runRecord('error', performance.now() - run.startedAt, { code: 'connection', message: error instanceof Error ? error.message : '接続に失敗しました' }));
        venue.current?.close();
        venue.current = null;
        stopRun('connection-error');
        setVenueEnabled(false);
        setVenueStatus(error instanceof Error ? error.message : '接続に失敗しました');
        setVenueMetrics(null);
      }
    }
  };

  const nameError = validateDeviceName('mic', deviceName);
  const start = async (takeover = false) => {
    const audio = await openMic();
    if (!audio || nameError) return;
    await sender.start(toPublishTracks([audio.streamTrack], undefined, AUDIO_PUBLISH), deviceName, mutedRef.current, takeover);
  };
  const toggleMute = (value: boolean) => {
    mutedRef.current = value;
    setMuted(value);
    if (track) track.enabled = !value;
    sender.setMuted(value);
  };
  const resumeAudio = () => {
    if (!prepared.current) return;
    try {
      const next = prepareMicAudio(prepared.current);
      prepared.current = next;
      void next.ready.then(() => setAudioInterrupted(false)).catch((error: unknown) => {
        recordClientDiagnostic(error, 'media.microphone.audio-context-resume');
        setAudioError('音声を再開できませんでした。画面を開いたまま、もう一度操作してください。');
      });
    } catch (error) {
      recordClientDiagnostic(error, 'media.microphone.audio-context-resume');
      setAudioError('音声を再開できませんでした。画面を開いたまま、もう一度操作してください。');
    }
  };
  const error = sender.state.error ?? mediaError;

  return (
    <SenderShell title="マイク送信" description="登壇者・質問者の声を配信に送ります。" status={<ConnectionStatus status={sender.state.status} />}>
      <LevelMeter label="入力レベル" value={level} muted={muted} />
      {!track && <Button variant="outline" className="h-11 w-full" onClick={() => void openMic()}><Mic aria-hidden />マイクを確認</Button>}
      <DeviceNameSelect id="mic-device-name" options={options} value={deviceName} onChange={setDeviceName} disabled={!canStart(sender.state.status)} />
      <div className="flex min-h-11 items-center justify-between">
        <Label htmlFor="mic-mute" className="gap-2">{muted ? <MicOff aria-hidden className="size-4" /> : <Mic aria-hidden className="size-4" />}ミュート（配信・会場の両方）</Label>
        <Switch id="mic-mute" checked={muted} onCheckedChange={toggleMute} />
      </div>
      <div className="flex min-h-11 items-center justify-between">
        <Label htmlFor="venue-audio" className="gap-2">会場スピーカーにも送信</Label>
        <Switch id="venue-audio" checked={venueEnabled} onCheckedChange={(value) => void toggleVenue(value)} />
      </div>
      <p className="text-sm text-muted-foreground">会場音声: {venueStatus}。配信用の音声処理は会場音声にかかりません。</p>
      {processingStatus && <p className="text-sm text-muted-foreground">{processingStatus}。実際の遅延は会場で確認してください。</p>}
      {venueTrialId() && <p className="text-sm text-muted-foreground">試験名: <code>{venueTrialId()}</code></p>}
      {audioGraph?.dspMode === 'bypass' && <ErrorNotice>配信用音声処理をバイパスしています。配信音質を確認してください。</ErrorNotice>}
      {audioInterrupted && <ErrorNotice>音声処理が停止しています。<Button type="button" variant="outline" onClick={resumeAudio}>音声を再開</Button></ErrorNotice>}
      {audioError && <ErrorNotice>{audioError}</ErrorNotice>}
      {nameError && <ErrorNotice>{nameError}</ErrorNotice>}
      {error && <SenderErrorNotice error={error} purpose="mic" deviceName={deviceName} onTakeover={() => void start(true)} />}
      {isActive(sender.state.status) ? (
        <Button variant="outline" className="h-11 w-full" onClick={sender.stop}><Square aria-hidden />送信停止</Button>
      ) : (
        <Button className="h-11 w-full" onClick={() => void start()} disabled={!canStart(sender.state.status) || Boolean(nameError)}>
          <Mic aria-hidden />送信開始
        </Button>
      )}
      {isActive(sender.state.status) && <p className="text-sm text-muted-foreground">送信中は画面を消さないでください。回線が切れても自動で再接続します。</p>}
      <VenueRunControls runId={runIdValue} slot={venueMetrics?.slot ?? null} metrics={venueMetrics} onFailure={setAudioError} side="mic" transport="pcm" />
      <p className="text-sm text-muted-foreground">複数端末のログを照合する場合は、各端末の URL に同じ <code>?trialId=試験名</code> を付けてください。</p>
    </SenderShell>
  );
}

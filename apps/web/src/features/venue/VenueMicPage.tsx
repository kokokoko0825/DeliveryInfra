import { useEffect, useRef, useState } from 'react';
import { Download, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SenderShell } from '@/features/sender/components';
import { startVenueMic, type VenueSession, type VenueSessionMetrics, type VenueTransport } from './venueAudio';
import {
  appendVenueRunRecord,
  createVenueRun,
  endVenueRun,
  exportVenueRun,
  listVenueRuns,
  type VenueRunMetadata,
  type VenueRunRecord,
} from './venueRunLog';
import { saveBlob } from '@/lib/download';
import { createVenueAcousticRecorder, type VenueAcousticRecorder } from './venueAcousticRecorder';
import { recordClientDiagnostic } from '@/lib/diagnostics';

type SlotChoice = 'auto' | number;
type RunControlsProps = {
  runId: string | null;
  slot: number | null;
  metrics: VenueSessionMetrics | null;
  onFailure: (message: string) => void;
  side: 'mic' | 'speaker';
  transport: VenueTransport;
};

export function VenueRunControls({ runId, slot, metrics, onFailure, side, transport }: RunControlsProps) {
  const [runs, setRuns] = useState<VenueRunMetadata[]>([]);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const reloadRuns = () => listVenueRuns().then(setRuns).catch((reason) => {
    recordClientDiagnostic(reason, 'venue.run-log.list', { phase: 'history-load', side });
    onFailure('IndexedDB の保存済みランを読み込めませんでした。ブラウザのサイトデータ設定を確認してください。');
  });
  useEffect(() => { void reloadRuns(); }, []);

  const download = async (id: string, format: 'csv' | 'json') => {
    setExporting(`${id}:${format}`);
    setExportError(null);
    try {
      const result = await exportVenueRun(id);
      const content = format === 'csv' ? result.csv : result.manifestJson;
      const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
      saveBlob(new Blob([content], { type: mime }), `venue-run-${id}.${format === 'csv' ? 'csv' : 'json'}`);
    } catch (reason) {
      recordClientDiagnostic(reason, 'venue.run-log.export', { phase: 'export', side, format });
      const message = reason instanceof Error ? reason.message : 'エクスポートに失敗しました';
      setExportError(`ラン ${id} を出力できませんでした: ${message}`);
    } finally { setExporting(null); }
  };

  return (
    <section className="space-y-3 rounded-md border p-3" aria-label="ランの保存とエクスポート">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">計測ログ（この端末の IndexedDB）</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => void reloadRuns()}>履歴を更新</Button>
      </div>
      {exporting && <p role="status" className="text-sm">CSV / JSON manifest を準備しています…</p>}
      {runId && <div className="space-y-2 rounded border p-2 text-sm">
        <p>現在のラン: <code>{runId}</code>{slot !== null && <> / 自分のスロット: {side === 'mic' ? 'MIC' : 'SPK'}{slot}</>} / 音声方式: {transport}</p>
        {metrics && <p>接続: {metrics.connectedPeers}/{metrics.activePeers} peers</p>}
        <ExportButtons id={runId} exporting={exporting} onDownload={download} />
      </div>}
      {exportError && <p role="alert" className="text-sm text-destructive">{exportError}</p>}
      {runs.length === 0 ? <p className="text-sm text-muted-foreground">保存済みランはありません。</p> : <ul className="space-y-2">
        {runs.map((run) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
          <span><code>{run.id}</code> · {new Date(run.startedAtUtc).toLocaleString()} · {run.peers.find((peer) => peer.startsWith('config.transport='))?.slice('config.transport='.length) ?? '方式不明'}{run.endedAtUtc ? ' · 終了' : ' · 記録中'}</span>
          <ExportButtons id={run.id} exporting={exporting} onDownload={download} />
        </li>)}
      </ul>}
    </section>
  );
}

function ExportButtons({ id, exporting, onDownload }: { id: string; exporting: string | null; onDownload: (id: string, format: 'csv' | 'json') => void }) {
  return <span className="flex gap-2">
    <Button type="button" size="sm" variant="outline" disabled={exporting !== null} onClick={() => onDownload(id, 'csv')}><Download aria-hidden /> CSV</Button>
    <Button type="button" size="sm" variant="outline" disabled={exporting !== null} onClick={() => onDownload(id, 'json')}><Download aria-hidden /> JSON manifest</Button>
  </span>;
}

function utcNow() { return new Date().toISOString(); }
function runId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function failureMessage(reason: unknown) {
  if (reason instanceof DOMException && reason.name === 'NotAllowedError')
    return 'マイクの使用が許可されていません。iPhone/iPad では設定アプリでブラウザのマイク権限を許可し、このページを再読み込みしてください。';
  if (reason instanceof DOMException && reason.name === 'NotFoundError') return '使用できるマイクが見つかりません。';
  return reason instanceof Error ? reason.message : 'マイク接続に失敗しました。診断ログとネットワーク接続を確認してください。';
}
function isAbortError(reason: unknown) { return reason instanceof DOMException && reason.name === 'AbortError' || reason instanceof Error && reason.name === 'AbortError'; }

export function metricsValues(metrics: VenueSessionMetrics): Record<string, number | null> {
  const values: Record<string, number | null> = {
    roleIsMic: metrics.role === 'mic' ? 1 : 0,
    ownSlot: metrics.slot,
    transportPcm: metrics.transport === 'pcm' ? 1 : 0,
    transportAudioTrack: metrics.transport === 'audio-track' ? 1 : 0,
    activePeers: metrics.activePeers, connectedPeers: metrics.connectedPeers,
    sentPackets: metrics.sentPackets, sentBytes: metrics.sentBytes, backpressureDrops: metrics.backpressureDrops,
    receivedPackets: metrics.receivedPackets, receivedBytes: metrics.receivedBytes,
    sequenceGaps: metrics.sequenceGaps, duplicates: metrics.duplicates, invalidPackets: metrics.invalidPackets,
    diagnosticRttMs: metrics.rttMs,
  };
  for (const peer of metrics.peers) {
    const prefix = `peer.${peer.peerId}`;
    values[`${prefix}.slot`] = peer.slot;
    values[`${prefix}.micSlot`] = peer.micSlot;
    values[`${prefix}.speakerSlot`] = peer.speakerSlot;
    values[`${prefix}.active`] = peer.active ? 1 : 0;
    values[`${prefix}.sideIsMic`] = peer.side === 'mic' ? 1 : 0;
    values[`${prefix}.stateCode`] = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].indexOf(peer.state);
    values[`${prefix}.iceStateCode`] = ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'].indexOf(peer.iceState);
    values[`${prefix}.iceGatheringStateCode`] = ['new', 'gathering', 'complete'].indexOf(peer.iceGatheringState);
    values[`${prefix}.signalingStateCode`] = ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'].indexOf(peer.signalingState);
    values[`${prefix}.connected`] = peer.connected ? 1 : 0;
    values[`${prefix}.sentPackets`] = peer.sentPackets;
    values[`${prefix}.sentBytes`] = peer.sentBytes;
    values[`${prefix}.backpressureDrops`] = peer.backpressureDrops;
    values[`${prefix}.receivedPackets`] = peer.receivedPackets;
    values[`${prefix}.receivedBytes`] = peer.receivedBytes;
    values[`${prefix}.sequenceGaps`] = peer.sequenceGaps;
    values[`${prefix}.duplicates`] = peer.duplicates;
    values[`${prefix}.invalidPackets`] = peer.invalidPackets;
    values[`${prefix}.rttMs`] = peer.rttMs;
  }
  for (const stream of metrics.workletStreams) {
    const prefix = `worklet.${stream.micId}`;
    values[`${prefix}.queuedMs`] = stream.queuedMs;
    values[`${prefix}.underflows`] = stream.underflows;
    values[`${prefix}.overflows`] = stream.overflows;
    values[`${prefix}.dropped`] = stream.dropped;
    values[`${prefix}.peak`] = stream.peak;
  }
  return values;
}

function runRecord<T extends VenueRunRecord>(type: T['type'], id: string, elapsedMs: number, fields: Omit<T, 'type' | 'id' | 'atUtc' | 'elapsedMs'>): T {
  return { type, id, atUtc: utcNow(), elapsedMs, ...fields } as T;
}

export default function VenueMicPage() {
  const [status, setStatus] = useState('停止');
  const [error, setError] = useState<string | null>(null);
  const [slotChoice, setSlotChoice] = useState<SlotChoice>('auto');
  const [transport, setTransport] = useState<VenueTransport>('pcm');
  const [runTransport, setRunTransport] = useState<VenueTransport>('pcm');
  const [ownSlot, setOwnSlot] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<VenueSessionMetrics | null>(null);
  const [runIdValue, setRunIdValue] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingAvailable, setRecordingAvailable] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<VenueAcousticRecorder | null>(null);
  const session = useRef<VenueSession | null>(null);
  const runRef = useRef<string | null>(null);
  const startMono = useRef(0);
  const sampleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const peerStates = useRef(new Map<string, string>());

  const write = (record: VenueRunRecord) => {
    const id = runRef.current;
    if (!id) return;
    writeQueue.current = writeQueue.current.then(() => appendVenueRunRecord(id, record)).then(() => undefined).catch((reason) => {
      recordClientDiagnostic(reason, 'venue.run-log.write', { runId: id, recordType: record.type });
      setError(`計測ログを保存できませんでした: ${reason instanceof Error ? reason.message : 'IndexedDB error'}`);
    });
  };
  const event = (name: string, detail?: string) => {
    const fields = { event: name, ...(detail ? { detail } : {}) };
    write(runRecord('transport', `event-${Date.now()}-${Math.random()}`, performance.now() - startMono.current, fields));
  };
  const stopRecording = async () => {
    const current = recorder.current;
    if (!current) return;
    const startedRunId = runRef.current ?? runIdValue;
    try {
      const result = await current.stop();
      if (result.byteCount === 0) throw new Error('録音データがありません。音が入っていることを確認して再録音してください。');
      const id = runRef.current ?? runIdValue;
      if (!id) throw new Error('録音を紐付けるラン ID がありません。');
      saveBlob(result.blob, `venue-run-${id}-acoustic.${result.extension}`);
      setRecordingError(null);
    } catch (reason) {
      if (!isAbortError(reason)) {
        const message = reason instanceof Error ? reason.message : '音響証拠の保存に失敗しました';
        recordClientDiagnostic(reason, 'venue.recording', { phase: 'stop', side: 'mic', runId: startedRunId });
        setRecordingError(message);
        if (startedRunId) write(runRecord('error', `recording-error-${Date.now()}`, performance.now() - startMono.current, { code: 'recording', message }));
      }
    } finally {
      current.cleanup();
      if (recorder.current === current) recorder.current = null;
      setRecording(false);
    }
  };
  const startRecording = () => {
    if (!stream.current) return;
    try {
      const current = createVenueAcousticRecorder(stream.current);
      current.start();
      recorder.current = current;
      setRecordingError(null);
      setRecording(true);
    } catch (reason) {
      if (!isAbortError(reason)) {
        const message = reason instanceof Error ? reason.message : 'このブラウザでは音声を録音できません';
        recordClientDiagnostic(reason, 'venue.recording', { phase: 'start', side: 'mic', runId: runRef.current });
        setRecordingError(message);
        if (runRef.current) write(runRecord('error', `recording-error-${Date.now()}`, performance.now() - startMono.current, { code: 'recording', message }));
      }
    }
  };
  const stop = async () => {
    if (sampleTimer.current) clearInterval(sampleTimer.current);
    sampleTimer.current = null;
    await stopRecording();
    session.current?.close();
    session.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setRecordingAvailable(false);
    if (runRef.current) {
      event('stop');
      const id = runRef.current;
      writeQueue.current = writeQueue.current.then(() => endVenueRun(id, utcNow())).then(() => undefined).catch((reason) => {
        recordClientDiagnostic(reason, 'venue.run-log.end', { phase: 'stop', side: 'mic', runId: id });
        setError(`ランを終了保存できませんでした: ${reason instanceof Error ? reason.message : 'IndexedDB error'}`);
      });
      runRef.current = null;
    }
    setStatus('停止');
    setMetrics(null);
    peerStates.current.clear();
  };

  useEffect(() => () => {
    if (sampleTimer.current) clearInterval(sampleTimer.current);
    session.current?.close();
    const activeRecorder = recorder.current;
    const idForRecording = runRef.current ?? runIdValue;
    if (activeRecorder) {
      void activeRecorder.stop().then((result) => {
        if (result.byteCount > 0 && idForRecording) saveBlob(result.blob, `venue-run-${idForRecording}-acoustic.${result.extension}`);
      }).catch((reason) => {
        if (!isAbortError(reason)) recordClientDiagnostic(reason, 'venue.recording', { phase: 'unmount-stop', side: 'mic', runId: idForRecording });
      }).finally(() => activeRecorder.cleanup());
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    if (runRef.current) {
      const id = runRef.current;
      const elapsedMs = performance.now() - startMono.current;
      writeQueue.current = writeQueue.current
        .then(() => appendVenueRunRecord(id, runRecord('transport', `unmount-${Date.now()}`, elapsedMs, { event: 'stop', detail: 'page-unmount' })))
        .then(() => endVenueRun(id, utcNow())).catch((reason) => { recordClientDiagnostic(reason, 'venue.run-log.end', { phase: 'unmount', side: 'mic', runId: id }); });
    }
  }, []);

  const sample = (current: VenueSession) => {
    const snapshot = current.getMetrics();
    setMetrics(snapshot);
    setOwnSlot(snapshot.slot);
    const elapsedMs = performance.now() - startMono.current;
    write(runRecord('health', `health-${Math.floor(elapsedMs / 1000)}`, elapsedMs, { values: metricsValues(snapshot) }));
    for (const peer of snapshot.peers) {
      const state = `${peer.state}:${peer.connected ? 'connected' : 'disconnected'}`;
      if (peerStates.current.get(peer.peerId) !== state) {
        peerStates.current.set(peer.peerId, state);
        write(runRecord('peer', `peer-${peer.peerId}-${Math.floor(elapsedMs)}-${state}`, elapsedMs, { peerId: peer.peerId, event: state }));
      }
    }
  };

  const starting = useRef(false);
  const start = async () => {
    if (session.current || runRef.current || starting.current) return;
    starting.current = true;
    setError(null);
    const id = runId();
    const startedAtUtc = utcNow();
    try {
      // The fixed runlog schema has no transport field; reserve a config marker in peers.
      await createVenueRun({ id, startedAtUtc, userAgent: navigator.userAgent, peers: [`config.transport=${transport}`] });
      runRef.current = id;
      setRunIdValue(id);
      setRunTransport(transport);
      startMono.current = performance.now();
      event('start', `transport=${transport}`);
      setStatus('マイクを開いています');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (runRef.current !== id) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      setStatus('相手を待っています');
      const current = await startVenueMic(media, { transport, ...(slotChoice === 'auto' ? {} : { slot: slotChoice }) });
      if (runRef.current !== id) { current.close(); return; }
      session.current = current;
      const snapshot = current.getMetrics();
      setOwnSlot(snapshot.slot);
      setMetrics(snapshot);
      setRecordingAvailable(true);
      write(runRecord('slot', `slot-${Date.now()}`, performance.now() - startMono.current, { peerId: 'self', event: 'assigned', detail: `MIC${snapshot.slot}; transport=${transport}` }));
      sampleTimer.current = setInterval(() => sample(current), 1000);
      void current.connected.then(() => {
        if (session.current === current) setStatus('接続中');
      }).catch((reason) => {
        if (session.current !== current) return;
        const message = failureMessage(reason);
        write(runRecord('error', `error-${Date.now()}`, performance.now() - startMono.current, { code: 'connection', message }));
        setError(message);
        setStatus('エラー');
      });
    } catch (reason) {
      if (isAbortError(reason)) {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        if (runRef.current) {
          const id = runRef.current;
          runRef.current = null;
          await endVenueRun(id, utcNow()).catch((cleanupError) => recordClientDiagnostic(cleanupError, 'venue.run-log.end', { phase: 'cancel-start', side: 'mic', runId: id }));
        }
        setStatus('停止');
        setRecordingAvailable(false);
        return;
      }
      const message = failureMessage(reason);
      recordClientDiagnostic(reason, 'venue.session', { phase: 'start', side: 'mic', transport, slot: slotChoice === 'auto' ? null : slotChoice });
      if (runRef.current) {
        write(runRecord('error', `error-${Date.now()}`, performance.now() - startMono.current, { code: 'start', message }));
        const closingRun = runRef.current;
        writeQueue.current = writeQueue.current.then(() => endVenueRun(closingRun, utcNow())).then(() => undefined).catch((cleanupError) => { recordClientDiagnostic(cleanupError, 'venue.run-log.end', { phase: 'failed-start', side: 'mic', runId: closingRun }); });
        runRef.current = null;
      }
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      setError(message);
      setStatus('エラー');
      setRecordingAvailable(false);
    } finally {
      starting.current = false;
    }
  };

  return (
    <SenderShell title="会場音声 PoC: マイク" description="音声と計測ログは端末内に保存し、サーバーへアップロードしません。" status={<span>{status}</span>}>
      <p role="status" className="text-sm">状態: {status}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <label className="block space-y-1 text-sm">マイクスロット
        <select aria-label="マイクスロット" className="block h-10 w-full rounded border bg-background px-2" value={slotChoice} disabled={runRef.current !== null} onChange={(e) => setSlotChoice(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
          <option value="auto">Auto（空き枠を選択）</option>
          {[1, 2, 3].map((slot) => <option key={slot} value={slot}>MIC{slot}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-sm">音声方式
        <select aria-label="音声方式" className="block h-10 w-full rounded border bg-background px-2" value={transport} disabled={runRef.current !== null} onChange={(e) => setTransport(e.target.value as VenueTransport)}>
          <option value="pcm">DataChannel PCM</option><option value="audio-track">WebRTC 音声トラック</option>
        </select>
      </label>
      {ownSlot !== null && <p className="text-sm">自分のスロット: MIC{ownSlot}</p>}
      {metrics && <section aria-label="接続メトリクス" className="space-y-1 text-sm">
        <p>ピア接続: {metrics.connectedPeers}/{metrics.activePeers}</p>
        <p>診断 RTT: {metrics.rttMs === null ? '未計測' : `${metrics.rttMs.toFixed(1)} ms`}（ネットワーク往復時間。片道音声遅延ではありません）</p>
        <ul>{metrics.peers.map((peer) => <li key={peer.peerId}>{peer.side === 'speaker' ? 'SPK' : 'MIC'}{peer.slot}: {peer.connected ? '接続済み' : peer.state} / ICE {peer.iceState} / SDP {peer.signalingState}</li>)}</ul>
      </section>}
      {recordingAvailable && <section aria-label="音響証拠録音" className="space-y-2 rounded border p-3">
        <p className="text-sm">音響証拠の録音は端末内で行い、停止時にファイルを保存します。基準音とスピーカー戻り音の記録に使えますが、校正された遅延測定ではありません。</p>
        {recording ? <Button type="button" variant="outline" onClick={() => void stopRecording()}><Square aria-hidden />録音停止して保存</Button> : <Button type="button" variant="outline" onClick={startRecording}><Download aria-hidden />音響証拠を録音</Button>}
        {recordingError && <p role="alert" className="text-sm text-destructive">{recordingError}</p>}
      </section>}
      {!runRef.current ? <Button className="h-11 w-full" onClick={() => void start()}><Mic aria-hidden />接続開始</Button> : <Button variant="outline" className="h-11 w-full" onClick={stop}><Square aria-hidden />停止</Button>}
      <p className="text-sm text-muted-foreground">iPhone/iPad で許可画面が表示された場合はマイク使用を許可してください。同じルームのスピーカー端末を開始すると接続します。</p>
      <VenueRunControls runId={runIdValue} slot={ownSlot} metrics={metrics} onFailure={setError} side="mic" transport={runTransport} />
    </SenderShell>
  );
}

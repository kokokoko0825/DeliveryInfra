import { useEffect, useRef, useState } from 'react';
import { MonitorPlay, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SenderShell } from '@/features/sender/components';
import { prepareVenueSpeakerAudio, startVenueSpeaker, type PreparedVenueSpeakerAudio, type VenueSession, type VenueSessionMetrics, type VenueTransport } from './venueAudio';
import { metricsValues, VenueRunControls } from './VenueMicPage';
import { holdWakeLock } from '@/lib/ivs/wakeLock';
import {
  appendVenueRunRecord,
  createVenueRun,
  endVenueRun,
  type VenueRunRecord,
} from './venueRunLog';

type SlotChoice = 'auto' | number;
function nowUtc() { return new Date().toISOString(); }
function newRunId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function errorMessage(reason: unknown) {
  if (reason instanceof DOMException && reason.name === 'NotAllowedError')
    return '音声再生がブラウザにブロックされました。iPhone/iPad ではこの開始ボタンから再試行し、無音の場合はブラウザの自動再生設定と端末の消音スイッチを確認してください。';
  return reason instanceof Error ? reason.message : 'スピーカー接続に失敗しました。同じ LAN の接続を確認してください。';
}
function record<T extends VenueRunRecord>(type: T['type'], id: string, elapsedMs: number, fields: Omit<T, 'type' | 'id' | 'atUtc' | 'elapsedMs'>): T {
  return { type, id, atUtc: nowUtc(), elapsedMs, ...fields } as T;
}

export default function VenueSpeakerPage() {
  const [status, setStatus] = useState('停止');
  const [error, setError] = useState<string | null>(null);
  const [slotChoice, setSlotChoice] = useState<SlotChoice>('auto');
  const [transport, setTransport] = useState<VenueTransport>('pcm');
  const [runTransport, setRunTransport] = useState<VenueTransport>('pcm');
  const [ownSlot, setOwnSlot] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<VenueSessionMetrics | null>(null);
  const [runIdValue, setRunIdValue] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const session = useRef<VenueSession | null>(null);
  const runRef = useRef<string | null>(null);
  const startMono = useRef(0);
  const sampler = useRef<ReturnType<typeof setInterval> | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const peerStates = useRef(new Map<string, string>());

  useEffect(() => () => {
    if (sampler.current) clearInterval(sampler.current);
    session.current?.close();
    if (runRef.current) {
      const id = runRef.current;
      const elapsedMs = performance.now() - startMono.current;
      writeQueue.current = writeQueue.current
        .then(() => appendVenueRunRecord(id, record('transport', `unmount-${Date.now()}`, elapsedMs, { event: 'stop', detail: 'page-unmount' })))
        .then(() => endVenueRun(id, nowUtc())).catch(() => undefined);
    }
  }, []);
  useEffect(() => status === '停止' || status === 'エラー' ? undefined : holdWakeLock(), [status]);

  const write = (item: VenueRunRecord) => {
    const id = runRef.current;
    if (!id) return;
    writeQueue.current = writeQueue.current.then(() => appendVenueRunRecord(id, item)).then(() => undefined).catch((reason) => {
      setError(`計測ログを保存できませんでした: ${reason instanceof Error ? reason.message : 'IndexedDB error'}`);
    });
  };
  const addEvent = (name: string, detail?: string) => write(record('transport', `event-${Date.now()}-${Math.random()}`, performance.now() - startMono.current, { event: name, ...(detail ? { detail } : {}) }));
  const stop = () => {
    if (sampler.current) clearInterval(sampler.current);
    sampler.current = null;
    session.current?.close();
    session.current = null;
    if (runRef.current) {
      addEvent('stop');
      const id = runRef.current;
      writeQueue.current = writeQueue.current.then(() => endVenueRun(id, nowUtc())).then(() => undefined).catch((reason) => {
        setError(`ランを終了保存できませんでした: ${reason instanceof Error ? reason.message : 'IndexedDB error'}`);
      });
      runRef.current = null;
    }
    setStatus('停止');
    setMetrics(null);
    setActive(false);
    peerStates.current.clear();
  };
  const updateMetrics = (current: VenueSession, id: string) => {
    const snapshot = current.getMetrics();
    const elapsedMs = performance.now() - startMono.current;
    setMetrics(snapshot);
    setOwnSlot(snapshot.slot);
    write(record('health', `health-${Math.floor(elapsedMs / 1000)}`, elapsedMs, { values: metricsValues(snapshot) }));
    for (const peer of snapshot.peers) {
      const state = `${peer.state}:${peer.connected ? 'connected' : 'disconnected'}`;
      if (peerStates.current.get(peer.peerId) !== state) {
        peerStates.current.set(peer.peerId, state);
        write(record('peer', `peer-${peer.peerId}-${Math.floor(elapsedMs)}-${state}`, elapsedMs, { peerId: peer.peerId, event: state }));
      }
    }
    void id;
  };
  const starting = useRef(false);
  const start = async (audio: PreparedVenueSpeakerAudio) => {
    if (session.current || runRef.current || starting.current) { void audio.context.close(); return; }
    starting.current = true;
    setError(null);
    const id = newRunId();
    try {
      // `audio.ready` was started synchronously by the button's user gesture.
      await audio.ready;
      // The fixed runlog schema has no transport field; reserve a config marker in peers.
      await createVenueRun({ id, startedAtUtc: nowUtc(), userAgent: navigator.userAgent, peers: [`config.transport=${transport}`] });
      runRef.current = id;
      setRunIdValue(id);
      setRunTransport(transport);
      setActive(true);
      startMono.current = performance.now();
      addEvent('start', `transport=${transport}`);
      setStatus('マイク端末を待っています');
      const current = await startVenueSpeaker(() => undefined, { transport, ...(slotChoice === 'auto' ? {} : { slot: slotChoice }) }, audio);
      if (runRef.current !== id) { current.close(); return; }
      session.current = current;
      updateMetrics(current, id);
      const assigned = current.getMetrics().slot;
      write(record('slot', `slot-${Date.now()}`, performance.now() - startMono.current, { peerId: 'self', event: 'assigned', detail: `SPK${assigned}; transport=${transport}` }));
      sampler.current = setInterval(() => updateMetrics(current, id), 1000);
      void current.connected.then(() => {
        if (session.current === current) setStatus('接続中');
      }).catch((reason) => {
        if (session.current !== current) return;
        const message = errorMessage(reason);
        write(record('error', `error-${Date.now()}`, performance.now() - startMono.current, { code: 'connection', message }));
        setError(message);
        setStatus('エラー');
      });
    } catch (reason) {
      void audio.context.close();
      const message = errorMessage(reason);
      if (runRef.current) {
        write(record('error', `error-${Date.now()}`, performance.now() - startMono.current, { code: 'start', message }));
        const endedRun = runRef.current;
        writeQueue.current = writeQueue.current.then(() => endVenueRun(endedRun, nowUtc())).then(() => undefined).catch(() => undefined);
        runRef.current = null;
      }
      setError(message);
      setStatus('エラー');
      setActive(false);
    } finally {
      starting.current = false;
    }
  };

  return <SenderShell title="会場音声 PoC: スピーカー" description="DataChannel 音声をローカル再生します。ログはこの端末の IndexedDB に保存します。" status={<span>{status}</span>}>
    <p role="status" className="text-sm">状態: {status}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <label className="block space-y-1 text-sm">スピーカースロット
      <select aria-label="スピーカースロット" className="block h-10 w-full rounded border bg-background px-2" value={slotChoice} disabled={active} onChange={(e) => setSlotChoice(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
        <option value="auto">Auto（空き枠を選択）</option>
        {[1, 2, 3, 4, 5].map((slot) => <option key={slot} value={slot}>SPK{slot}</option>)}
      </select>
    </label>
    <label className="block space-y-1 text-sm">音声方式
      <select aria-label="音声方式" className="block h-10 w-full rounded border bg-background px-2" value={transport} disabled={active} onChange={(e) => setTransport(e.target.value as VenueTransport)}>
        <option value="pcm">DataChannel PCM</option><option value="audio-track">WebRTC 音声トラック</option>
      </select>
    </label>
    {ownSlot !== null && <p className="text-sm">自分のスロット: SPK{ownSlot}</p>}
    {metrics && <section aria-label="接続メトリクス" className="space-y-1 text-sm">
      <p>ピア接続: {metrics.connectedPeers}/{metrics.activePeers}</p>
      <p>診断 RTT: {metrics.rttMs === null ? '未計測' : `${metrics.rttMs.toFixed(1)} ms`}（ネットワーク往復時間。片道音声遅延ではありません）</p>
      <ul>{metrics.peers.map((peer) => <li key={peer.peerId}>{peer.side === 'mic' ? 'MIC' : 'SPK'}{peer.slot}: {peer.connected ? '接続済み' : peer.state}</li>)}</ul>
      {metrics.workletStreams.map((stream) => <p key={stream.micId}>{stream.micId}: {stream.queuedMs} ms queued / underflow {stream.underflows} / overflow {stream.overflows}</p>)}
    </section>}
    {!active ? <Button className="h-11 w-full" onClick={() => void start(prepareVenueSpeakerAudio())}><MonitorPlay aria-hidden />受信開始</Button> : <Button variant="outline" className="h-11 w-full" onClick={stop}><Square aria-hidden />停止</Button>}
    <p className="text-sm text-muted-foreground">開始ボタンを押すと音声再生を有効化します。iPhone/iPad で無音の場合は自動再生設定と端末の消音スイッチを確認し、停止して再度開始してください。診断 RTT は片道音声遅延ではありません。</p>
    <VenueRunControls runId={runIdValue} slot={ownSlot} metrics={metrics} onFailure={setError} side="speaker" transport={runTransport} />
  </SenderShell>;
}

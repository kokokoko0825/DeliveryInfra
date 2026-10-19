import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { StageName } from '@delivery/shared';
import { createManagedSession, type ManagedSession, type ManagedStatus } from '@/lib/ivs/managedSession';
import { createSwitcherTokens, requestStageTokens } from '@/lib/ivs/mediaApi';
import { bitrateKbps, sumOutboundBytes, type ByteSample } from '@/lib/ivs/stats';
import { holdWakeLock } from '@/lib/ivs/wakeLock';
import { composeFrame } from './engine/compose';
import { PROGRAM_FPS, PROGRAM_SIZE } from './engine/layout';
import { channelOf, gainOf, initialMixerState, mixerReducer, type ChannelId } from './engine/mixer';
import { remoteReducer, routeMedia, type ReceiveStage, type RemoteState } from './engine/remote';
import { STANDBY, type SourceId } from './engine/scene';
import { healthOf, type SourceHealth } from './engine/sources';
import { initialSwitcherState, switcherReducer } from './engine/state';
import { transitionProgress } from './engine/transition';
import { createAudioGraph, type AudioGraph } from './media/audioGraph';
import { createDefaultStandby, drawFrame, type Drawable } from './media/compositor';
import { startFrameClock } from './media/frameClock';
import { createVideoRegistry } from './media/videoRegistry';

export const HEALTH_INTERVAL_MS = 500;
export const LEVEL_INTERVAL_MS = 100;
export const BITRATE_INTERVAL_MS = 2000;
export const BROADCAST_VIDEO = { maxVideoBitrateKbps: 2500, maxFramerate: PROGRAM_FPS } as const;
export const BROADCAST_AUDIO = { maxAudioBitrateKbps: 128, stereo: true } as const;

export type StageStatuses = Record<StageName, ManagedStatus>;
export type Levels = { channels: Map<ChannelId, number>; master: number };

/**
 * スイッチング画面の中核。制作用・スライド用ステージを受信し、Canvas 合成 + WebAudio ミックスを配信用ステージへ送る。
 * 判断は engine/ の純粋関数に任せ、ここは配線だけを行う。
 */
export function useSwitcher() {
  const [switcher, dispatch] = useReducer(switcherReducer, initialSwitcherState);
  const [mixer, mixerDispatch] = useReducer(mixerReducer, initialMixerState);
  const [remote, remoteDispatch] = useReducer(remoteReducer<MediaStreamTrack>, { entries: [] } satisfies RemoteState<MediaStreamTrack>);
  const routed = useMemo(() => routeMedia(remote), [remote]);
  const [running, setRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [statuses, setStatuses] = useState<StageStatuses>({ production: 'idle', slide: 'idle', broadcast: 'idle' });
  const [health, setHealth] = useState<Map<SourceId, SourceHealth>>(new Map());
  const [levels, setLevels] = useState<Levels>({ channels: new Map(), master: 0 });
  const [bitrate, setBitrate] = useState<number | null>(null);
  const [standbyImage, setStandbyImage] = useState<Drawable | null>(null);

  const registry = useMemo(() => createVideoRegistry(), []);
  const switcherToken = useMemo(() => createSwitcherTokens(() => requestStageTokens('switcher')), []);
  const graph = useRef<AudioGraph | null>(null);
  const sessions = useRef<Partial<Record<StageName, ManagedSession>>>({});
  const programTrack = useRef<MediaStreamTrack | null>(null);
  const programCanvas = useRef<HTMLCanvasElement | null>(null);
  const previewCanvas = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef(switcher);
  latest.current = switcher;
  const standby = useRef<Drawable | null>(null);
  standby.current = standbyImage;

  const setStatus = useCallback((stage: StageName, status: ManagedStatus) => setStatuses((current) => ({ ...current, [stage]: status })), []);

  // 受信トラック → 合成用 <video> / ミキサーのチャンネル
  useEffect(() => {
    for (const source of registry.sources()) if (!routed.video.has(source)) registry.set(source, null);
    for (const [source, track] of routed.video) registry.set(source, track);
  }, [registry, routed.video]);
  useEffect(() => {
    const audio = graph.current;
    if (!audio) return;
    for (const [id, track] of routed.audio) audio.setChannelTrack(id, track);
  }, [routed.audio, running]);
  const previousChannels = useRef<Set<ChannelId>>(new Set());
  useEffect(() => {
    const audio = graph.current;
    if (!audio) return;
    for (const id of previousChannels.current) if (!routed.audio.has(id)) audio.setChannelTrack(id, null);
    previousChannels.current = new Set(routed.audio.keys());
  }, [routed.audio, running]);
  useEffect(() => {
    const audio = graph.current;
    if (!audio) return;
    for (const id of routed.audio.keys()) audio.setGain(id, gainOf(channelOf(mixer, id)));
    audio.setMasterGain(gainOf(mixer.master));
  }, [mixer, routed.audio, running]);

  // 合成ループ（Worker タイマー駆動。背面タブでも止まらない）
  useEffect(() => {
    if (!running) return undefined;
    const program = programCanvas.current?.getContext('2d') ?? null;
    const preview = previewCanvas.current?.getContext('2d') ?? null;
    const resolve = (source: SourceId) => (source === STANDBY ? standby.current : registry.element(source));
    let frame = 0;
    return startFrameClock(PROGRAM_FPS, () => {
      const now = performance.now();
      const state = latest.current;
      if (state.active && transitionProgress(state.active.startedAt, state.active.durationMs, now) >= 1) dispatch({ type: 'TICK', now });
      if (program) drawFrame(program, composeFrame(state.program, state.active, now), resolve, PROGRAM_SIZE);
      frame += 1;
      // プレビューは半分のフレームレートで十分
      if (preview && frame % 2 === 0) drawFrame(preview, composeFrame(state.preview, null, now), resolve, PROGRAM_SIZE);
    });
  }, [registry, running]);

  // 接続状態・映像途絶
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      const now = performance.now();
      const frames = registry.sample(now);
      const next = new Map<SourceId, SourceHealth>();
      for (const [source, lastFrameAt] of frames) next.set(source, healthOf({ connected: routed.video.has(source), lastFrameAt }, now));
      setHealth(next);
    }, HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [registry, routed.video, running]);

  // レベルメーター
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { if (graph.current) setLevels(graph.current.levels()); }, LEVEL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running]);

  // 送信ビットレート
  useEffect(() => {
    if (!publishing) return undefined;
    let previous: ByteSample | null = null;
    const timer = setInterval(() => {
      void sessions.current.broadcast?.getOutboundStats().then((report) => {
        const sample = report ? sumOutboundBytes(report.values()) : null;
        setBitrate(bitrateKbps(previous, sample));
        previous = sample;
      }).catch(() => undefined);
    }, BITRATE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      setBitrate(null);
    };
  }, [publishing]);

  useEffect(() => (running ? holdWakeLock() : undefined), [running]);

  const receive = useCallback((stage: ReceiveStage) => createManagedSession({
    fetchToken: () => switcherToken(stage),
    publish: false,
    subscribe: true,
    onStatus: (status) => setStatus(stage, status),
    onReset: () => remoteDispatch({ type: 'RESET', stage }),
    handlers: {
      onStreamsAdded: (participant, tracks) => remoteDispatch({ type: 'STREAMS_ADDED', stage, participant, tracks }),
      onStreamsRemoved: (participant, tracks) => remoteDispatch({ type: 'STREAMS_REMOVED', participantId: participant.id, tracks }),
      onParticipantLeft: (participant) => remoteDispatch({ type: 'LEFT', participantId: participant.id }),
    },
  }), [setStatus, switcherToken]);

  /** 起動: 音声の再生許可が要るため、ボタン操作から呼ぶ。 */
  const start = useCallback(async () => {
    if (running) return;
    graph.current ??= createAudioGraph();
    await graph.current.resume();
    if (!standby.current) setStandbyImage(createDefaultStandby(PROGRAM_SIZE));
    setRunning(true);
    const production = receive('production');
    const slide = receive('slide');
    sessions.current.production = production;
    sessions.current.slide = slide;
    // 失敗しても再接続は予約される
    await Promise.allSettled([production.start(), slide.start()]);
  }, [receive, running]);

  const stopPublishing = useCallback(() => {
    sessions.current.broadcast?.stop();
    delete sessions.current.broadcast;
    programTrack.current?.stop();
    programTrack.current = null;
    setPublishing(false);
  }, []);

  /** 番組（合成映像 + ミックス音声）を配信用ステージへ送り始める。 */
  const startPublishing = useCallback(async () => {
    const canvas = programCanvas.current;
    const audio = graph.current?.track ?? null;
    if (!canvas || typeof canvas.captureStream !== 'function') throw new Error('このブラウザは番組映像の送信に対応していません');
    sessions.current.broadcast?.stop();
    programTrack.current?.stop();
    const video = canvas.captureStream(PROGRAM_FPS).getVideoTracks()[0] ?? null;
    programTrack.current = video;
    if (!video) throw new Error('番組映像を取得できませんでした');
    const tracks = [{ track: video, config: BROADCAST_VIDEO }, ...(audio ? [{ track: audio, config: BROADCAST_AUDIO }] : [])];
    const broadcast = createManagedSession({ fetchToken: () => switcherToken('broadcast'), publish: true, subscribe: false, tracks, onStatus: (status) => setStatus('broadcast', status) });
    sessions.current.broadcast = broadcast;
    try {
      await broadcast.start();
      setPublishing(true);
    } catch (error) {
      stopPublishing();
      throw error;
    }
  }, [setStatus, stopPublishing, switcherToken]);

  useEffect(() => () => {
    Object.values(sessions.current).forEach((session) => session?.stop());
    sessions.current = {};
    programTrack.current?.stop();
    registry.dispose();
    graph.current?.close();
    graph.current = null;
  }, [registry]);

  return {
    switcher, dispatch, mixer, mixerDispatch, routed, running, publishing, statuses, health, levels, bitrate,
    standbyImage, setStandbyImage, programCanvas, previewCanvas, registry, start, startPublishing, stopPublishing,
  };
}

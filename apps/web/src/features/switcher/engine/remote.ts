/** 受信中の参加者とトラックの一覧（純粋）。T はトラック型（テストでは任意の値）。 */
import type { ParticipantKind } from '@/lib/ivs/strategy';
import { MAX_MIC_CHANNELS, micChannel, SLIDE_CHANNEL, type ChannelId } from './mixer';
import { cameraSource, SLIDE, type SourceId } from './scene';
import { MAX_CAMERAS, orderDevices } from './sources';

export type ReceiveStage = 'production' | 'slide';
export type RemoteEntry<T> = { participantId: string; stage: ReceiveStage; kind: ParticipantKind; deviceName: string; video: T | null; audio: T | null };
export type RemoteState<T> = { entries: RemoteEntry<T>[] };
type Participant = { id: string; kind: ParticipantKind; deviceName: string };
type Track<T> = { kind: 'audio' | 'video'; track: T };

export type RemoteAction<T> =
  | { type: 'STREAMS_ADDED'; stage: ReceiveStage; participant: Participant; tracks: Track<T>[] }
  | { type: 'STREAMS_REMOVED'; participantId: string; tracks: Track<T>[] }
  | { type: 'LEFT'; participantId: string }
  | { type: 'RESET'; stage: ReceiveStage };

export function remoteReducer<T>(state: RemoteState<T>, action: RemoteAction<T>): RemoteState<T> {
  switch (action.type) {
    case 'STREAMS_ADDED': {
      const previous = state.entries.find((entry) => entry.participantId === action.participant.id);
      const video = action.tracks.find((track) => track.kind === 'video')?.track ?? previous?.video ?? null;
      const audio = action.tracks.find((track) => track.kind === 'audio')?.track ?? previous?.audio ?? null;
      const entry: RemoteEntry<T> = { participantId: action.participant.id, stage: action.stage, kind: action.participant.kind, deviceName: action.participant.deviceName, video, audio };
      // 新しいものを末尾へ（同じ端末名なら後勝ち）
      return { entries: [...state.entries.filter((item) => item.participantId !== action.participant.id), entry] };
    }
    case 'STREAMS_REMOVED':
      return {
        entries: state.entries.map((entry) => {
          if (entry.participantId !== action.participantId) return entry;
          const removed = new Set(action.tracks.map((track) => track.track));
          return { ...entry, video: entry.video !== null && removed.has(entry.video) ? null : entry.video, audio: entry.audio !== null && removed.has(entry.audio) ? null : entry.audio };
        }),
      };
    case 'LEFT':
      return { entries: state.entries.filter((entry) => entry.participantId !== action.participantId) };
    case 'RESET':
      return { entries: state.entries.filter((entry) => entry.stage !== action.stage) };
  }
}

export type RoutedMedia<T> = { video: Map<SourceId, T>; audio: Map<ChannelId, T>; cameraNames: string[]; micNames: string[] };

/**
 * 参加者を合成用のソース・ミキサーのチャンネルに振り分ける。
 * カメラは制作用ステージの camera（最大6）、マイクは mic（最大5）、スライドはスライド用ステージの slide の映像と PC 音声。
 */
export function routeMedia<T>(state: RemoteState<T>): RoutedMedia<T> {
  const video = new Map<SourceId, T>();
  const audio = new Map<ChannelId, T>();
  const cameras = state.entries.filter((entry) => entry.stage === 'production' && entry.kind === 'camera');
  const mics = state.entries.filter((entry) => entry.stage === 'production' && entry.kind === 'mic');
  const cameraNames = orderDevices(cameras.map((entry) => entry.deviceName), MAX_CAMERAS);
  const micNames = orderDevices(mics.map((entry) => entry.deviceName), MAX_MIC_CHANNELS);
  for (const entry of cameras) if (entry.video !== null && cameraNames.includes(entry.deviceName)) video.set(cameraSource(entry.deviceName), entry.video);
  for (const entry of mics) if (entry.audio !== null && micNames.includes(entry.deviceName)) audio.set(micChannel(entry.deviceName), entry.audio);
  for (const entry of state.entries) {
    if (entry.stage !== 'slide' || entry.kind !== 'slide') continue;
    if (entry.video !== null) video.set(SLIDE, entry.video);
    if (entry.audio !== null) audio.set(SLIDE_CHANNEL, entry.audio);
  }
  return { video, audio, cameraNames, micNames };
}

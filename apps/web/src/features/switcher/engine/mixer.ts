/** 音声ミキサーの状態とゲイン計算（純粋）。カメラ切替とは独立（F-SW-07）。 */
import { z } from 'zod';
import { STAGE_LIMITS } from '@delivery/shared';

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;
export const DEFAULT_VOLUME = 80;
export const VolumeSchema = z.number().int().min(VOLUME_MIN).max(VOLUME_MAX);

/** チャンネル ID: マイクは `mic:<端末名>`、スライド PC 音声は `slide`。 */
export type ChannelId = `mic:${string}` | 'slide';
export const SLIDE_CHANNEL: ChannelId = 'slide';
export const micChannel = (deviceName: string): ChannelId => `mic:${deviceName}`;
export const MAX_MIC_CHANNELS = STAGE_LIMITS.mic;

export type Channel = { volume: number; muted: boolean };
export type MixerState = { channels: Record<string, Channel>; master: Channel };

export type MixerAction =
  | { type: 'SET_VOLUME'; channel: ChannelId; volume: number }
  | { type: 'SET_MUTED'; channel: ChannelId; muted: boolean }
  | { type: 'SET_MASTER_VOLUME'; volume: number }
  | { type: 'SET_MASTER_MUTED'; muted: boolean };

export const initialMixerState: MixerState = { channels: {}, master: { volume: VOLUME_MAX, muted: false } };

export const channelOf = (state: MixerState, channel: ChannelId): Channel => state.channels[channel] ?? { volume: DEFAULT_VOLUME, muted: false };

export function mixerReducer(state: MixerState, action: MixerAction): MixerState {
  switch (action.type) {
    case 'SET_VOLUME':
      if (!VolumeSchema.safeParse(action.volume).success) return state;
      return { ...state, channels: { ...state.channels, [action.channel]: { ...channelOf(state, action.channel), volume: action.volume } } };
    case 'SET_MUTED':
      return { ...state, channels: { ...state.channels, [action.channel]: { ...channelOf(state, action.channel), muted: action.muted } } };
    case 'SET_MASTER_VOLUME':
      if (!VolumeSchema.safeParse(action.volume).success) return state;
      return { ...state, master: { ...state.master, volume: action.volume } };
    case 'SET_MASTER_MUTED':
      return { ...state, master: { ...state.master, muted: action.muted } };
  }
}

/** 音量 0〜100 を聴感に近い2乗カーブでゲイン 0〜1 にする。ミュートは 0。 */
export function gainOf(channel: Channel): number {
  if (channel.muted) return 0;
  const volume = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, channel.volume));
  return (volume / VOLUME_MAX) ** 2;
}

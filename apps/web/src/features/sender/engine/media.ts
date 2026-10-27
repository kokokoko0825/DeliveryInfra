/** メディア取得の制約・送信設定と、入力レベル計算（純粋関数）。 */
import type { PublishTrack } from '@/lib/ivs/stage';

export type Facing = 'user' | 'environment';

export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;

/** カメラ: 720p / 30fps、音声なし（F-CAM-01, 03）。 */
export function cameraConstraints(facing: Facing): MediaStreamConstraints {
  return {
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: VIDEO_WIDTH }, height: { ideal: VIDEO_HEIGHT }, frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS } },
  };
}

/** マイク: 取得時処理をオフに要求し、Web Audio で会場用と配信用に分岐する。 */
export function micConstraints(): MediaStreamConstraints {
  return { video: false, audio: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
}

/** 画面共有: 1280x720 最大30fps、システム/タブ音声を含める（F-SHR-03, 04）。 */
export function displayMediaOptions(): DisplayMediaStreamOptions & Record<string, unknown> {
  return {
    video: { width: { ideal: VIDEO_WIDTH, max: VIDEO_WIDTH }, height: { ideal: VIDEO_HEIGHT, max: VIDEO_HEIGHT }, frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS } },
    // 処理を切ってスライド内の動画音声をそのまま送る
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  };
}

export const CAMERA_PUBLISH = { maxVideoBitrateKbps: 2000, maxFramerate: VIDEO_FPS } as const;
export const SLIDE_PUBLISH = { maxVideoBitrateKbps: 2500, maxFramerate: VIDEO_FPS } as const;
export const AUDIO_PUBLISH = { maxAudioBitrateKbps: 64 } as const;
export const PC_AUDIO_PUBLISH = { maxAudioBitrateKbps: 128, stereo: true } as const;

/** トラック種別に応じて送信設定を付ける。 */
export function toPublishTracks(tracks: MediaStreamTrack[], video: PublishTrack['config'], audio: PublishTrack['config']): PublishTrack[] {
  return tracks.map((track) => ({ track, config: track.kind === 'video' ? video : audio }));
}

export const LEVEL_FLOOR_DB = -60;

/** 時間波形の RMS。 */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** RMS を dBFS に換算し、-60dB〜0dB を 0〜100 に割り当てる。 */
export function levelPercent(value: number): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  const clamped = Math.min(0, Math.max(LEVEL_FLOOR_DB, db));
  return Math.round(((clamped - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB) * 100);
}

/** メーター表示の平滑化: 上がるときは即時、下がるときは decay ずつ。 */
export function smoothLevel(previous: number, next: number, decay = 4): number {
  return next >= previous ? next : Math.max(next, previous - decay);
}

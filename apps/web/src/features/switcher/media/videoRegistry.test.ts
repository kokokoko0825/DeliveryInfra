import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakeTrack, installMediaGlobals } from '@/lib/ivs/testing';
import { cameraSource, SLIDE } from '../engine/scene';
import { createVideoRegistry } from './videoRegistry';

const CAM1 = cameraSource('CAM1');
const track = () => new FakeTrack('video');

/** 受信映像の再生状態（デコード済みフレーム数・readyState）を差し替える。 */
function playback(video: HTMLVideoElement | null, state: { frames?: number; readyState?: number; currentTime?: number }) {
  if (!video) throw new Error('video がありません');
  if (state.frames !== undefined) {
    const frames = state.frames;
    Object.defineProperty(video, 'getVideoPlaybackQuality', { value: () => ({ totalVideoFrames: frames }), configurable: true });
  }
  if (state.readyState !== undefined) Object.defineProperty(video, 'readyState', { value: state.readyState, configurable: true });
  if (state.currentTime !== undefined) Object.defineProperty(video, 'currentTime', { value: state.currentTime, configurable: true });
}

beforeEach(() => installMediaGlobals());
afterEach(() => vi.restoreAllMocks());

describe('createVideoRegistry', () => {
  it('plays each received track in a muted inline video element', () => {
    const registry = createVideoRegistry();
    const camera = track();
    registry.set(CAM1, camera as unknown as MediaStreamTrack);
    const video = registry.element(CAM1)!;
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect((video.srcObject as unknown as FakeMediaStream).tracks).toEqual([camera]);
    expect(registry.stream(CAM1)).toBe(video.srcObject);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(registry.sources()).toEqual([CAM1]);
    expect(registry.element(SLIDE)).toBeNull();
    expect(registry.stream(SLIDE)).toBeNull();
  });

  it('keeps the element for the same track and replaces it for a new one', () => {
    const registry = createVideoRegistry();
    const first = track() as unknown as MediaStreamTrack;
    registry.set(CAM1, first);
    const video = registry.element(CAM1);
    registry.set(CAM1, first);
    expect(registry.element(CAM1)).toBe(video);
    registry.set(CAM1, track() as unknown as MediaStreamTrack);
    expect(registry.element(CAM1)).not.toBe(video);
    expect(video?.srcObject).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });

  it('records the time of the last decoded frame, only once the video has data', () => {
    const registry = createVideoRegistry();
    registry.set(CAM1, track() as unknown as MediaStreamTrack);
    const video = registry.element(CAM1);
    playback(video, { frames: 0, readyState: 1 });
    expect(registry.sample(1000).get(CAM1)).toBeNull();
    playback(video, { readyState: 2 });
    expect(registry.sample(1500).get(CAM1)).toBe(1500);
    // フレームが進まなければ時刻は据え置き（2秒経てば映像途絶と判定される）
    expect(registry.sample(4000).get(CAM1)).toBe(1500);
    playback(video, { frames: 30 });
    expect(registry.sample(4500).get(CAM1)).toBe(4500);
  });

  it('falls back to currentTime where playback quality is unavailable', () => {
    const registry = createVideoRegistry();
    registry.set(CAM1, track() as unknown as MediaStreamTrack);
    const video = registry.element(CAM1)!;
    Object.defineProperty(video, 'getVideoPlaybackQuality', { value: undefined, configurable: true });
    playback(video, { readyState: 4, currentTime: 0 });
    expect(registry.sample(100).get(CAM1)).toBe(100);
    expect(registry.sample(200).get(CAM1)).toBe(100);
    playback(video, { currentTime: 0.0004 });
    expect(registry.sample(300).get(CAM1)).toBe(100);
    playback(video, { currentTime: 0.033 });
    expect(registry.sample(400).get(CAM1)).toBe(400);
  });

  it('reports an ended track as having no frame', () => {
    const registry = createVideoRegistry();
    const camera = track();
    registry.set(CAM1, camera as unknown as MediaStreamTrack);
    playback(registry.element(CAM1), { frames: 5, readyState: 4 });
    expect(registry.sample(10).get(CAM1)).toBe(10);
    camera.end();
    expect(registry.sample(20).get(CAM1)).toBeNull();
  });

  it('removes a source on null and disposes everything', () => {
    const registry = createVideoRegistry();
    registry.set(CAM1, track() as unknown as MediaStreamTrack);
    registry.set(SLIDE, track() as unknown as MediaStreamTrack);
    const camera = registry.element(CAM1);
    registry.set(CAM1, null);
    expect(registry.sources()).toEqual([SLIDE]);
    expect(camera?.srcObject).toBeNull();
    registry.set(CAM1, null);
    registry.dispose();
    expect(registry.sources()).toEqual([]);
    expect(registry.sample(0).size).toBe(0);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
  });
});

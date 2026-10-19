/**
 * 受信映像トラックを合成用の <video> 要素として保持し、フレームの進みを記録する。
 * requestVideoFrameCallback は背面タブで止まるため、デコード済みフレーム数をタイマーで調べる。
 */
import type { SourceId } from '../engine/scene';

type Entry = { track: MediaStreamTrack; video: HTMLVideoElement; frames: number; lastFrameAt: number | null };

const decodedFrames = (video: HTMLVideoElement): number => {
  const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
  return quality ? quality.totalVideoFrames : Math.round(video.currentTime * 1000);
};

export function createVideoRegistry() {
  const entries = new Map<SourceId, Entry>();

  const remove = (source: SourceId) => {
    const entry = entries.get(source);
    if (!entry) return;
    entry.video.pause();
    entry.video.srcObject = null;
    entries.delete(source);
  };

  return {
    set(source: SourceId, track: MediaStreamTrack | null) {
      const current = entries.get(source);
      if (current?.track === track) return;
      remove(source);
      if (!track) return;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      void video.play().catch(() => undefined);
      entries.set(source, { track, video, frames: -1, lastFrameAt: null });
    },
    element: (source: SourceId) => entries.get(source)?.video ?? null,
    stream: (source: SourceId) => (entries.get(source)?.video.srcObject as MediaStream | null | undefined) ?? null,
    /** フレームが進んだソースの lastFrameAt を now に更新し、全ソースの値を返す。 */
    sample(now: number): Map<SourceId, number | null> {
      const result = new Map<SourceId, number | null>();
      for (const [source, entry] of entries) {
        const frames = decodedFrames(entry.video);
        if (frames !== entry.frames && entry.video.readyState >= 2) {
          entry.frames = frames;
          entry.lastFrameAt = now;
        }
        result.set(source, entry.track.readyState === 'ended' ? null : entry.lastFrameAt);
      }
      return result;
    },
    sources: () => [...entries.keys()],
    dispose() {
      [...entries.keys()].forEach(remove);
    },
  };
}
export type VideoRegistry = ReturnType<typeof createVideoRegistry>;

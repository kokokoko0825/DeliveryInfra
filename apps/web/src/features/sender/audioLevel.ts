import { useEffect, useState } from 'react';
import { levelPercent, rms, smoothLevel } from './engine/media';

export const LEVEL_INTERVAL_MS = 100;

/** AnalyserNode の現在レベル（0〜100）。 */
export function readAnalyserLevel(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  return levelPercent(rms(buffer));
}

/** 音声トラックの入力レベル。タイマーで読むため、タブが背面でも止まらない。 */
export function useAudioLevel(track: MediaStreamTrack | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => setLevel((previous) => smoothLevel(previous, readAnalyserLevel(analyser, buffer))), LEVEL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      source.disconnect();
      void context.close();
      setLevel(0);
    };
  }, [track]);
  return level;
}

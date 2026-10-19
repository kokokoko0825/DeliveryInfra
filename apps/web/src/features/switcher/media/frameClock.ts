/**
 * 合成用のフレームクロック。requestAnimationFrame は背面タブで止まるため使わない。
 * Worker のタイマーを使い、使えない環境では setInterval にフォールバックする。
 */
export function startFrameClock(fps: number, onTick: () => void): () => void {
  const intervalMs = Math.round(1000 / fps);
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./frameClock.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = onTick;
      worker.postMessage({ intervalMs });
      return () => {
        worker.postMessage('stop');
        worker.terminate();
      };
    } catch {
      // フォールバックへ
    }
  }
  const timer = setInterval(onTick, intervalMs);
  return () => clearInterval(timer);
}

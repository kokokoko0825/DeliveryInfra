/// <reference lib="webworker" />
// 背面タブでも間引かれにくい Worker 内タイマー。メインスレッドへ tick を送るだけ。
let timer: ReturnType<typeof setInterval> | undefined;
self.onmessage = (event: MessageEvent<{ intervalMs: number } | 'stop'>) => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (event.data !== 'stop') timer = setInterval(() => self.postMessage(0), event.data.intervalMs);
};

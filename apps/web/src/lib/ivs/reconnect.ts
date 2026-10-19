/** 自動再接続の制御（DOM/IVS 非依存）。待ち時間は lib/retry の backoffMs を使う。 */
import { backoffMs } from '@/lib/retry';

export type Scheduler = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 接続処理 connect を失敗時にバックオフ付きで繰り返す。
 * stop() 後は connect を呼ばない。成功で attempt をリセットする。
 * trigger() は待機中・接続中なら何もしない（切断イベントの重複通知を1回にまとめる）。
 */
export function createReconnector(connect: () => Promise<void>, scheduler: Scheduler = realScheduler, delay: (attempt: number) => number = backoffMs) {
  let attempt = 0;
  let handle: unknown = null;
  let stopped = true;
  let running = false;

  const schedule = () => {
    if (stopped || running || handle !== null) return;
    const wait = delay(attempt);
    attempt += 1;
    handle = scheduler.setTimeout(() => { run().catch(() => undefined); }, wait);
  };
  const run = async () => {
    handle = null;
    if (stopped || running) return;
    running = true;
    try {
      await connect();
      attempt = 0;
      running = false;
    } catch (error) {
      running = false;
      schedule();
      throw error;
    }
  };

  return {
    /** 即時に接続を試みる。失敗時は例外を返しつつ再試行を予約する。 */
    start: () => {
      stopped = false;
      attempt = 0;
      return run();
    },
    /** 切断を検知したときに呼ぶ。バックオフ後に再接続する。 */
    trigger: schedule,
    stop: () => {
      stopped = true;
      if (handle !== null) scheduler.clearTimeout(handle);
      handle = null;
    },
    get attempt() { return attempt; },
    get pending() { return handle !== null; },
  };
}
export type Reconnector = ReturnType<typeof createReconnector>;

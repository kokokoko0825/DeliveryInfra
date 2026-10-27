/** 自動再接続の制御（DOM/IVS 非依存）。待ち時間は lib/retry の backoffMs を使う。 */
import { backoffMs } from '@/lib/retry';
import { recordClientDiagnostic } from '@/lib/diagnostics';

export type Scheduler = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 接続処理 connect を失敗時にバックオフ付きで繰り返す。
 * stop() 後は connect を呼ばない。成功で attempt をリセットする。
 * trigger() は予約済みの再試行を重複させず、接続中なら完了後の再試行を予約する。
 */
export function createReconnector(connect: () => Promise<void>, scheduler: Scheduler = realScheduler, delay: (attempt: number) => number = backoffMs) {
  let attempt = 0;
  let handle: unknown = null;
  let stopped = true;
  let running = false;
  let retryAfterRun = false;

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
      if (retryAfterRun && !stopped) {
        retryAfterRun = false;
        schedule();
      }
    } catch (error) {
      running = false;
      retryAfterRun = false;
      recordClientDiagnostic(error, 'ivs.reconnect', { retryAttempt: attempt });
      schedule();
      throw error;
    }
  };

  return {
    /** 即時に接続を試みる。失敗時は例外を返しつつ再試行を予約する。 */
    start: () => {
      stopped = false;
      attempt = 0;
      retryAfterRun = false;
      return run();
    },
    /** 切断を検知したときに呼ぶ。バックオフ後に再接続する。 */
    trigger: () => {
      if (running) { retryAfterRun = true; return; }
      schedule();
    },
    stop: () => {
      stopped = true;
      retryAfterRun = false;
      if (handle !== null) scheduler.clearTimeout(handle);
      handle = null;
    },
    get attempt() { return attempt; },
    get pending() { return handle !== null; },
  };
}

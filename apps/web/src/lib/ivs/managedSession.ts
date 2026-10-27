/**
 * 自動再接続付きのステージセッション。
 * 切断を検知したら古い接続を捨て、トークンを取り直して join し直す（参加トークンは短命で再利用できないため）。
 */
import { createReconnector, type Scheduler } from './reconnect';
import { createStageSession, type PublishTrack, type StageSession, type StageSessionHandlers } from './stage';

export type ManagedStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export type ManagedSessionOptions = {
  fetchToken: () => Promise<string>;
  publish: boolean;
  subscribe: boolean;
  tracks?: PublishTrack[];
  handlers?: StageSessionHandlers;
  onStatus?: (status: ManagedStatus) => void;
  /** 接続が失われ、受信中の参加者がいなくなったとき。 */
  onReset?: () => void;
  /** サーバー側から切断されたとき（再接続せずに止まる。例: 同じ端末名の別端末に引き継がれた）。 */
  onEnded?: (reason: string) => void;
  scheduler?: Scheduler;
};

export function createManagedSession(options: ManagedSessionOptions) {
  let session: StageSession | null = null;
  let tracks = options.tracks ?? [];
  let muted = false;
  let generation = 0;

  const drop = () => {
    session?.leave();
    session = null;
  };
  const connect = async () => {
    const currentGeneration = generation;
    drop();
    const token = await options.fetchToken();
    if (currentGeneration !== generation) return;
    const next = createStageSession(token, { publish: options.publish, subscribe: options.subscribe, tracks }, {
      ...options.handlers,
      onRecoverableLoss: (reason) => {
        if (session !== next) return;
        generation += 1;
        drop();
        options.onReset?.();
        options.onStatus?.('reconnecting');
        options.handlers?.onRecoverableLoss?.(reason);
        reconnector.trigger();
      },
      onEnded: (reason) => {
        if (session !== next) return;
        generation += 1;
        reconnector.stop();
        drop();
        options.onReset?.();
        options.onStatus?.('idle');
        options.handlers?.onEnded?.(reason);
        options.onEnded?.(reason);
      },
    });
    session = next;
    await next.join();
    if (session !== next) return;
    if (muted) next.setMuted('audio', true);
    options.onStatus?.('connected');
  };
  const reconnector = createReconnector(connect, options.scheduler);

  return {
    /** 初回接続。失敗時は例外を投げ、再試行を予約する（不要なら stop() を呼ぶ）。 */
    start: () => {
      generation += 1;
      options.onStatus?.('connecting');
      return reconnector.start();
    },
    /** 外部要因（ハートビート失効など）で接続し直す。 */
    restart: () => {
      generation += 1;
      drop();
      options.onReset?.();
      options.onStatus?.('reconnecting');
      reconnector.trigger();
    },
    stop: () => {
      generation += 1;
      reconnector.stop();
      drop();
      options.onReset?.();
      options.onStatus?.('idle');
    },
    setPublishTracks: (next: PublishTrack[]) => {
      tracks = next;
      session?.setPublishTracks(next);
      if (muted) session?.setMuted('audio', true);
    },
    setMuted: (value: boolean) => {
      muted = value;
      session?.setMuted('audio', value);
    },
    getOutboundStats: () => session?.getOutboundStats() ?? Promise.resolve(undefined),
  };
}
export type ManagedSession = ReturnType<typeof createManagedSession>;

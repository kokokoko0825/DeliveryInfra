import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageSessionHandlers } from './stage';

const fake = vi.hoisted(() => {
  const sessions: { token: string; handlers: StageSessionHandlers; options: { tracks: unknown[] }; join: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; setPublishTracks: ReturnType<typeof vi.fn>; setMuted: ReturnType<typeof vi.fn>; getOutboundStats: ReturnType<typeof vi.fn> }[] = [];
  return { sessions, joinDeferred: null as Promise<void> | null };
});
vi.mock('./stage', () => ({
  createStageSession: vi.fn((token: string, options: { tracks: unknown[] }, handlers: StageSessionHandlers) => {
    const session = { token, options, handlers, join: vi.fn(() => fake.joinDeferred ?? Promise.resolve()), leave: vi.fn(), setPublishTracks: vi.fn(), setMuted: vi.fn(), getOutboundStats: vi.fn().mockResolvedValue('report') };
    fake.sessions.push(session);
    return session;
  }),
}));

const { createManagedSession } = await import('./managedSession');

function scheduler() {
  const queue: (() => void)[] = [];
  return { queue, scheduler: { setTimeout: (fn: () => void) => { queue.push(fn); return queue.length; }, clearTimeout: () => { queue.length = 0; } } };
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const track = { track: {} as MediaStreamTrack };

beforeEach(() => { fake.sessions.length = 0; fake.joinDeferred = null; });

describe('createManagedSession', () => {
  it('uses an empty track list when no tracks are supplied', async () => {
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('token'), publish: false, subscribe: true });
    await managed.start();
    expect(fake.sessions[0]?.options.tracks).toEqual([]);
  });

  it('can update tracks and mute before joining or after stopping', async () => {
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('token'), publish: true, subscribe: false });
    expect(() => { managed.setMuted(true); managed.setPublishTracks([track]); }).not.toThrow();
    await managed.start();
    expect(fake.sessions[0]?.options.tracks).toEqual([track]);
    expect(fake.sessions[0]?.setMuted).toHaveBeenCalledWith('audio', true);
    managed.stop();
    expect(() => managed.setPublishTracks([])).not.toThrow();
  });

  it('handles loss and server ending without optional callbacks', async () => {
    const { queue, scheduler: s } = scheduler();
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('token'), publish: true, subscribe: false, scheduler: s });
    await managed.start();
    expect(() => fake.sessions[0]?.handlers.onRecoverableLoss?.('lost')).not.toThrow();
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    await flush();
    expect(() => fake.sessions[1]?.handlers.onEnded?.('ended')).not.toThrow();
  });

  it('does not join after stop while token retrieval is pending', async () => {
    let resolveToken: (token: string) => void = () => undefined;
    const fetchToken = vi.fn(() => new Promise<string>((resolve) => { resolveToken = resolve; }));
    const onStatus = vi.fn();
    const managed = createManagedSession({ fetchToken, publish: true, subscribe: false, onStatus });
    const starting = managed.start();
    managed.stop();
    resolveToken('late-token');
    await starting;
    expect(fake.sessions).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith('idle');
  });

  it('does not report connected after stop while joining', async () => {
    let finishJoin: () => void = () => undefined;
    fake.joinDeferred = new Promise<void>((resolve) => { finishJoin = resolve; });
    const onStatus = vi.fn();
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('token'), publish: true, subscribe: false, onStatus });
    const starting = managed.start();
    await flush();
    managed.stop();
    finishJoin();
    await starting;
    expect(onStatus).toHaveBeenLastCalledWith('idle');
    expect(fake.sessions[0]?.leave).toHaveBeenCalled();
  });

  it('retries when the session is lost while its initial join is still pending', async () => {
    const { queue, scheduler: s } = scheduler();
    let finishJoin: () => void = () => undefined;
    fake.joinDeferred = new Promise<void>((resolve) => { finishJoin = resolve; });
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('token'), publish: true, subscribe: false, scheduler: s });
    const starting = managed.start();
    await flush();
    fake.sessions[0]!.handlers.onRecoverableLoss?.('errored');
    fake.joinDeferred = null;
    finishJoin();
    await starting;
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    await flush();
    expect(fake.sessions).toHaveLength(2);
  });
  it('fetches a token, joins, and reports status', async () => {
    const onStatus = vi.fn();
    const fetchToken = vi.fn().mockResolvedValue('t1');
    const managed = createManagedSession({ fetchToken, publish: true, subscribe: false, tracks: [track], onStatus });
    await managed.start();
    expect(fake.sessions[0]?.token).toBe('t1');
    expect(fake.sessions[0]?.options.tracks).toEqual([track]);
    expect(fake.sessions[0]?.join).toHaveBeenCalled();
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(['connecting', 'connected']);
    expect(await managed.getOutboundStats()).toBe('report');
  });

  it('reconnects with a fresh token after a recoverable loss', async () => {
    const { queue, scheduler: s } = scheduler();
    const onStatus = vi.fn();
    const onReset = vi.fn();
    const onLoss = vi.fn();
    const fetchToken = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const managed = createManagedSession({ fetchToken, publish: false, subscribe: true, onStatus, onReset, scheduler: s, handlers: { onRecoverableLoss: onLoss } });
    await managed.start();
    const first = fake.sessions[0]!;
    first.handlers.onRecoverableLoss?.('errored');
    expect(first.leave).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onLoss).toHaveBeenCalledWith('errored');
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    // 古いセッションからの重複通知は無視する
    first.handlers.onRecoverableLoss?.('unknown');
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    await flush();
    expect(fake.sessions[1]?.token).toBe('t2');
    expect(onStatus).toHaveBeenLastCalledWith('connected');
  });

  it('keeps tracks and mute state across reconnects', async () => {
    const { queue, scheduler: s } = scheduler();
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('t'), publish: true, subscribe: false, scheduler: s });
    managed.setMuted(true);
    await managed.start();
    expect(fake.sessions[0]?.setMuted).toHaveBeenCalledWith('audio', true);
    managed.setPublishTracks([track]);
    expect(fake.sessions[0]?.setPublishTracks).toHaveBeenCalledWith([track]);
    expect(fake.sessions[0]?.setMuted).toHaveBeenCalledTimes(2);
    expect(fake.sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', true);
    managed.restart();
    queue.shift()?.();
    await flush();
    expect(fake.sessions[1]?.options.tracks).toEqual([track]);
    expect(fake.sessions[1]?.setMuted).toHaveBeenCalledWith('audio', true);
  });

  it('does not re-apply mute when unmuted', async () => {
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('t'), publish: true, subscribe: false });
    await managed.start();
    expect(fake.sessions[0]?.setMuted).not.toHaveBeenCalled();
    managed.setPublishTracks([]);
    expect(fake.sessions[0]?.setMuted).not.toHaveBeenCalled();
    managed.setMuted(false);
    expect(fake.sessions[0]?.setMuted).toHaveBeenCalledWith('audio', false);
    managed.stop();
  });

  it('stop leaves, resets, cancels retries and reports idle', async () => {
    const { queue, scheduler: s } = scheduler();
    const onStatus = vi.fn();
    const onReset = vi.fn();
    const managed = createManagedSession({ fetchToken: vi.fn().mockRejectedValue(new Error('down')), publish: true, subscribe: false, onStatus, onReset, scheduler: s });
    await expect(managed.start()).rejects.toThrow('down');
    expect(queue).toHaveLength(1);
    managed.stop();
    expect(queue).toHaveLength(0);
    expect(onReset).toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('idle');
    expect(await managed.getOutboundStats()).toBeUndefined();
  });

  it('stops without reconnecting when the server disconnects the participant (R3-02)', async () => {
    const { queue, scheduler: s } = scheduler();
    const onStatus = vi.fn();
    const onReset = vi.fn();
    const onEnded = vi.fn();
    const handlerEnded = vi.fn();
    const fetchToken = vi.fn().mockResolvedValue('t');
    const managed = createManagedSession({ fetchToken, publish: true, subscribe: false, onStatus, onReset, onEnded, scheduler: s, handlers: { onEnded: handlerEnded } });
    await managed.start();
    const first = fake.sessions[0]!;
    first.handlers.onEnded?.('participant-disconnected');
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith('idle');
    expect(onEnded).toHaveBeenCalledWith('participant-disconnected');
    expect(handlerEnded).toHaveBeenCalledWith('participant-disconnected');
    expect(queue).toHaveLength(0);
    // 以降の切断通知では再接続しない（相互切断ループの防止）
    first.handlers.onRecoverableLoss?.('errored');
    first.handlers.onEnded?.('participant-disconnected');
    expect(queue).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending reconnect when the server ends the session (R3-02)', async () => {
    const { queue, scheduler: s } = scheduler();
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('t'), publish: true, subscribe: false, scheduler: s });
    await managed.start();
    managed.restart();
    queue.shift()?.();
    await flush();
    fake.sessions[1]!.handlers.onRecoverableLoss?.('errored');
    expect(queue).toHaveLength(1);
    // 再接続待ちの間に古い（現在でない）セッションの終了通知が来ても無視する
    fake.sessions[0]!.handlers.onEnded?.('participant-disconnected');
    expect(queue).toHaveLength(1);
  });

  it('restart drops the current session and schedules a reconnect', async () => {
    const { queue, scheduler: s } = scheduler();
    const onStatus = vi.fn();
    const managed = createManagedSession({ fetchToken: vi.fn().mockResolvedValue('t'), publish: true, subscribe: false, onStatus, scheduler: s });
    await managed.start();
    managed.restart();
    expect(fake.sessions[0]?.leave).toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(queue).toHaveLength(1);
  });
});

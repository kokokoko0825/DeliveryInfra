import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageSessionHandlers } from './stage';

const fake = vi.hoisted(() => {
  const sessions: { token: string; handlers: StageSessionHandlers; options: { tracks: unknown[] }; join: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; setPublishTracks: ReturnType<typeof vi.fn>; setMuted: ReturnType<typeof vi.fn>; getOutboundStats: ReturnType<typeof vi.fn> }[] = [];
  return { sessions };
});
vi.mock('./stage', () => ({
  createStageSession: vi.fn((token: string, options: { tracks: unknown[] }, handlers: StageSessionHandlers) => {
    const session = { token, options, handlers, join: vi.fn().mockResolvedValue(undefined), leave: vi.fn(), setPublishTracks: vi.fn(), setMuted: vi.fn(), getOutboundStats: vi.fn().mockResolvedValue('report') };
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

beforeEach(() => { fake.sessions.length = 0; });

describe('createManagedSession', () => {
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

import { describe, expect, it, vi } from 'vitest';
import { createReconnector, realScheduler, type Scheduler } from './reconnect';

/** 手動で進めるスケジューラ。 */
function manualScheduler() {
  const queue: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => { id += 1; queue.push({ fn, ms, id }); return id; },
    clearTimeout: (handle) => { const index = queue.findIndex((item) => item.id === handle); if (index >= 0) queue.splice(index, 1); },
  };
  const flush = async () => { const next = queue.shift(); next?.fn(); await Promise.resolve(); await Promise.resolve(); return next?.ms; };
  return { scheduler, queue, flush };
}

describe('createReconnector', () => {
  it('connects immediately on start and resets attempts on success', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, (attempt) => attempt * 100 + 1);
    await reconnector.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(reconnector.attempt).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('rejects on a failed start and schedules a retry with backoff', async () => {
    const connect = vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y')).mockResolvedValue(undefined);
    const { scheduler, queue, flush } = manualScheduler();
    const delay = vi.fn((attempt: number) => (attempt + 1) * 1000);
    const reconnector = createReconnector(connect, scheduler, delay);
    await expect(reconnector.start()).rejects.toThrow('x');
    expect(reconnector.pending).toBe(true);
    expect(queue[0]?.ms).toBe(1000);
    expect(reconnector.attempt).toBe(1);
    expect(await flush()).toBe(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(queue[0]?.ms).toBe(2000);
    await flush();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(reconnector.attempt).toBe(0);
    expect(reconnector.pending).toBe(false);
    expect(delay).toHaveBeenNthCalledWith(1, 0);
    expect(delay).toHaveBeenNthCalledWith(2, 1);
  });

  it('collapses duplicate triggers into one pending retry', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, () => 10);
    await reconnector.start();
    reconnector.trigger();
    reconnector.trigger();
    expect(queue).toHaveLength(1);
  });

  it('does nothing when triggered before start or after stop', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, () => 10);
    reconnector.trigger();
    expect(queue).toHaveLength(0);
    await reconnector.start();
    reconnector.trigger();
    reconnector.stop();
    expect(queue).toHaveLength(0);
    expect(reconnector.pending).toBe(false);
    reconnector.trigger();
    expect(queue).toHaveLength(0);
  });

  it('does not reconnect when stopped while a scheduled retry fires', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, () => 10);
    await reconnector.start();
    reconnector.trigger();
    const pending = queue[0];
    reconnector.stop();
    pending?.fn();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('schedules one retry after a trigger during a running connection attempt', async () => {
    let resolve: () => void = () => undefined;
    const connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, () => 10);
    const started = reconnector.start();
    reconnector.trigger();
    expect(queue).toHaveLength(0);
    expect(connect).toHaveBeenCalledTimes(1);
    resolve();
    await started;
    expect(queue).toHaveLength(1);
    expect(reconnector.pending).toBe(true);
  });

  it('does not schedule a latched retry when stopped during an in-flight connection', async () => {
    let resolve: () => void = () => undefined;
    const connect = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { scheduler, queue } = manualScheduler();
    const reconnector = createReconnector(connect, scheduler, () => 10);
    const started = reconnector.start();
    reconnector.trigger();
    reconnector.stop();
    resolve();
    await started;
    expect(queue).toHaveLength(0);
    expect(reconnector.pending).toBe(false);
  });

  it('uses the lib/retry backoff by default', async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const reconnector = createReconnector(connect);
    await expect(reconnector.start()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('realScheduler clears timers', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const handle = realScheduler.setTimeout(fn, 10);
    realScheduler.clearTimeout(handle);
    vi.advanceTimersByTime(20);
    expect(fn).not.toHaveBeenCalled();
    realScheduler.setTimeout(fn, 10);
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFrameClock } from './frameClock';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static fail = false;
  onmessage: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(public url: URL, public options: WorkerOptions) {
    if (FakeWorker.fail) throw new Error('blocked');
    FakeWorker.instances.push(this);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.fail = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startFrameClock', () => {
  it('drives ticks from a module worker at 1000/fps ms so background tabs keep compositing', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onTick = vi.fn();
    const stop = startFrameClock(30, onTick);
    const worker = FakeWorker.instances[0]!;
    expect(worker.url.pathname).toMatch(/frameClock\.worker\.ts$/);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledWith({ intervalMs: 33 });
    worker.onmessage?.();
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    stop();
    expect(worker.postMessage).toHaveBeenLastCalledWith('stop');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('falls back to setInterval when workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    const onTick = vi.fn();
    const stop = startFrameClock(25, onTick);
    vi.advanceTimersByTime(39);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('falls back to setInterval when the worker cannot be created', () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = true;
    const onTick = vi.fn();
    const stop = startFrameClock(30, onTick);
    vi.advanceTimersByTime(99);
    expect(onTick).toHaveBeenCalledTimes(3);
    stop();
  });
});

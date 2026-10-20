import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type MessagePort = { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (data: unknown) => void };
type Processor = { port: MessagePort; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean; streams: Map<string, { packets: unknown[]; stats: Record<string, number> }>; jitterMs: number; maxPackets: number };

function createProcessor(jitterMs = 10) {
  let Registered: new (options: unknown) => Processor;
  class Base {
    port: MessagePort = { onmessage: null, postMessage: vi.fn() };
    constructor() { }
  }
  const source = readFileSync(resolve(import.meta.dirname, 'venue-pcm.worklet.js'), 'utf8');
  const registerProcessor = (_name: string, processor: typeof Registered) => { Registered = processor; };
  // Worklet source is a plain script and has no imports or DOM dependencies.
  new Function('AudioWorkletProcessor', 'registerProcessor', 'currentTime', 'sampleRate', source)(Base, registerProcessor, 0, 48000);
  const instance = new Registered!({ processorOptions: { jitterMs } });
  return instance;
}

function packet(value: number) {
  const data = new Int16Array(480);
  data.fill(value);
  return data.buffer;
}

function enqueue(processor: Processor, micId: string, sequence: number, timestamp: number, value = 1000) {
  processor.port.onmessage?.({ data: { type: 'enqueue', micId, sequence, timestamp, payload: packet(value) } });
}

function render(processor: Processor, frames = 480) {
  const output = new Float32Array(frames);
  processor.process([], [[output]]);
  return output;
}

import { vi } from 'vitest';

describe('venue PCM worklet', () => {
  it('mixes three concurrent streams with soft clipping and records peak metrics', () => {
    const processor = createProcessor();
    for (const micId of ['a', 'b', 'c']) enqueue(processor, micId, 0, 1000, 30000);
    const output = render(processor);
    expect(output[0]).toBeCloseTo((3 * 30000 / 32768) / (1 + 3 * 30000 / 32768), 5);
    expect(Math.max(...output)).toBeLessThan(1);
    const streams = processor.streams;
    expect(streams.size).toBe(3);
    expect([...streams.values()].every((stream) => (stream.stats.peak ?? 0) > 0)).toBe(true);
    enqueue(processor, 'd', 0, 1000);
    expect(streams.size).toBe(3);
  });

  it('accepts reordered packets, counts sequence gaps and rejects duplicates', () => {
    const processor = createProcessor(15);
    enqueue(processor, 'mic', 1, 1010);
    enqueue(processor, 'mic', 0, 1000);
    enqueue(processor, 'mic', 3, 1030);
    enqueue(processor, 'mic', 3, 1030);
    const stats = processor.streams.get('mic')!.stats;
    expect(stats.reordered).toBe(1);
    expect(stats.gaps).toBe(1);
    expect(stats.dropped).toBe(1);
  });

  it('bounds queues for the configurable 5–15 ms range and tracks overflow', () => {
    for (const jitterMs of [5, 10, 15]) {
      const processor = createProcessor(jitterMs);
      expect(processor.jitterMs).toBe(jitterMs);
      for (let sequence = 0; sequence < 8; sequence++) enqueue(processor, 'mic', sequence, sequence * 10);
      const stream = processor.streams.get('mic')!;
      expect(stream.packets.length).toBe(processor.maxPackets);
      expect(stream.stats.overflows).toBeGreaterThan(0);
    }
    expect(createProcessor(100).jitterMs).toBe(15);
    expect(createProcessor(1).jitterMs).toBe(5);
  });

  it('ignores malformed PCM packets and rejects invalid metadata', () => {
    const processor = createProcessor();
    processor.port.onmessage?.({ data: { type: 'enqueue', micId: 'mic', sequence: 0, timestamp: 1, payload: new ArrayBuffer(2) } });
    enqueue(processor, '', 1, 2);
    enqueue(processor, 'mic', -1, 2);
    enqueue(processor, 'mic', 1, Number.NaN);
    expect(processor.streams.size).toBe(0);
  });

  it('reports stable stats messages and counts per-stream underflow', () => {
    const processor = createProcessor();
    enqueue(processor, 'mic', 0, 1000);
    render(processor, 600);
    processor.port.onmessage?.({ data: { type: 'stats-request' } });
    const message = vi.mocked(processor.port.postMessage).mock.calls.at(-1)?.[0] as { type: string; streams: Array<{ micId: string; underflows: number; queuedMs: number }> };
    expect(message.type).toBe('stats');
    expect(message.streams[0]).toMatchObject({ micId: 'mic', underflows: 120, queuedMs: 0 });
  });
});

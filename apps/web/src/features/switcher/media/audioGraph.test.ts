import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakeTrack } from '@/lib/ivs/testing';

const level = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/features/sender/audioLevel', () => ({ readAnalyserLevel: level.read }));
const { createAudioGraph } = await import('./audioGraph');

type Node = { name: string; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; fftSize?: number; gain?: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> } };
const node = (name: string, extra: Partial<Node> = {}): Node => {
  const created: Node = { name, connect: vi.fn((next: Node) => next), disconnect: vi.fn(), ...extra };
  return created;
};

let contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  options: unknown;
  currentTime = 12.5;
  gains: Node[] = [];
  analysers: Node[] = [];
  sources: Node[] = [];
  destinationTrack = new FakeTrack('audio');
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  constructor(options: unknown) { this.options = options; contexts.push(this); }
  createGain() { const gain = node('gain', { gain: { value: 1, setTargetAtTime: vi.fn() } }); this.gains.push(gain); return gain; }
  createAnalyser() { const analyser = node('analyser', { fftSize: 2048 }); this.analysers.push(analyser); return analyser; }
  createMediaStreamDestination() { return { ...node('destination'), stream: new FakeMediaStream([this.destinationTrack]) }; }
  createMediaStreamSource(stream: unknown) { const source = { ...node('source'), stream }; this.sources.push(source); return source; }
}
const sinks: { muted: boolean; srcObject: unknown; play: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  contexts = [];
  sinks.length = 0;
  level.read.mockReset().mockReturnValue(0);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('Audio', class { muted = false; srcObject: unknown = null; play = vi.fn().mockResolvedValue(undefined); constructor() { sinks.push(this); } });
});
afterEach(() => vi.unstubAllGlobals());

const track = () => new FakeTrack('audio') as unknown as MediaStreamTrack;

describe('createAudioGraph', () => {
  it('routes master → analyser → destination at 48kHz and exposes the destination track', () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    expect(context.options).toEqual({ latencyHint: 'interactive', sampleRate: 48000 });
    const [master] = context.gains;
    const [masterAnalyser] = context.analysers;
    expect(master?.connect).toHaveBeenCalledWith(masterAnalyser);
    expect(masterAnalyser?.connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'destination' }));
    expect(masterAnalyser?.fftSize).toBe(1024);
    expect(graph.track).toBe(context.destinationTrack);
  });

  it('adds a channel silent until its gain is set, with a muted sink element for Chrome', () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    const mic = track();
    graph.setChannelTrack('mic:MIC1', mic);
    const gain = context.gains[1]!;
    const analyser = context.analysers[1]!;
    const source = context.sources[0]!;
    expect(gain.gain?.value).toBe(0);
    expect(analyser.fftSize).toBe(1024);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.gains[0]);
    expect(sinks[0]).toMatchObject({ muted: true });
    expect((sinks[0]?.srcObject as FakeMediaStream).tracks).toEqual([mic]);
    expect(sinks[0]?.play).toHaveBeenCalled();
  });

  it('applies a gain set before the track arrives and smooths later changes', () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    graph.setGain('mic:MIC1', 0.64);
    graph.setChannelTrack('mic:MIC1', track());
    const gain = context.gains[1]!;
    expect(gain.gain?.value).toBe(0.64);
    graph.setGain('mic:MIC1', 0.25);
    expect(gain.gain?.setTargetAtTime).toHaveBeenCalledWith(0.25, 12.5, 0.02);
    graph.setMasterGain(0);
    expect(context.gains[0]?.gain?.setTargetAtTime).toHaveBeenCalledWith(0, 12.5, 0.02);
    expect(() => graph.setGain('mic:MIC9', 1)).not.toThrow();
  });

  it('keeps the same track, replaces a new one and removes on null', () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    const first = track();
    graph.setChannelTrack('mic:MIC1', first);
    graph.setChannelTrack('mic:MIC1', first);
    expect(context.sources).toHaveLength(1);
    graph.setChannelTrack('mic:MIC1', track());
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.disconnect).toHaveBeenCalled();
    expect(context.gains[1]?.disconnect).toHaveBeenCalled();
    expect(sinks[0]?.srcObject).toBeNull();
    graph.setChannelTrack('mic:MIC1', null);
    expect(context.sources[1]?.disconnect).toHaveBeenCalled();
    expect(graph.levels().channels.size).toBe(0);
    expect(() => graph.setChannelTrack('mic:MIC2', null)).not.toThrow();
  });

  it('reads pre-fader channel levels and the post-fader master level', () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    graph.setChannelTrack('mic:MIC1', track());
    graph.setChannelTrack('slide', track());
    level.read.mockImplementation((analyser: Node) => (analyser === context.analysers[0] ? 40 : analyser === context.analysers[1] ? 70 : 10));
    const levels = graph.levels();
    expect([...levels.channels]).toEqual([['mic:MIC1', 70], ['slide', 10]]);
    expect(levels.master).toBe(40);
    expect((level.read.mock.calls[0]?.[1] as Float32Array).length).toBe(1024);
  });

  it('resumes and closes, removing every channel', async () => {
    const graph = createAudioGraph();
    const context = contexts[0]!;
    await graph.resume();
    expect(context.resume).toHaveBeenCalled();
    graph.setChannelTrack('mic:MIC1', track());
    graph.setChannelTrack('slide', track());
    graph.close();
    expect(context.sources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalled();
    expect(graph.levels().channels.size).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaStream, FakeTrack, installMediaGlobals } from '@/lib/ivs/testing';
import { createMicAudioGraph, prepareMicAudio } from './micAudioGraph';

class FakeNode {
  connections: FakeNode[] = [];
  connect = vi.fn((node: FakeNode) => { this.connections.push(node); return node; });
  disconnect = vi.fn((node?: FakeNode) => {
    this.connections = node ? this.connections.filter((item) => item !== node) : [];
  });
}

const contexts: FakeContext[] = [];
class FakeContext {
  state = 'running';
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  source = new FakeNode();
  destination = Object.assign(new FakeNode(), {
    channelCount: 2,
    channelCountMode: 'explicit',
    stream: { getAudioTracks: () => [this.outputTrack] },
  });
  analyser = Object.assign(new FakeNode(), { fftSize: 0, getFloatTimeDomainData: vi.fn((buffer: Float32Array) => buffer.fill(0)) });
  highPass = Object.assign(new FakeNode(), { type: '', frequency: { value: 0 } });
  compressor = Object.assign(new FakeNode(), {
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
  });
  outputTrack = new FakeTrack('audio', 'processed');
  createMediaStreamSource = vi.fn((stream: MediaStream) => { void stream; return this.source; });
  createMediaStreamDestination = vi.fn(() => this.destination);
  createAnalyser = vi.fn(() => this.analyser);
  createBiquadFilter = vi.fn(() => this.highPass);
  createDynamicsCompressor = vi.fn(() => this.compressor);
  constructor(public options?: AudioContextOptions) { contexts.push(this); }
}

beforeEach(() => {
  contexts.length = 0;
  installMediaGlobals();
  vi.stubGlobal('AudioContext', FakeContext);
});

describe('micAudioGraph', () => {
  it('resumes Web Audio from the initiating gesture and reuses one context', async () => {
    const first = prepareMicAudio();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.options).toEqual({ latencyHint: 'interactive', sampleRate: 48000 });
    expect(contexts[0]?.resume).toHaveBeenCalledOnce();
    const second = prepareMicAudio(first);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.resume).toHaveBeenCalledTimes(2);
    await second.ready;
  });

  it('publishes a processed track while leaving the source available to the venue branch', async () => {
    const raw = new FakeTrack('audio', 'raw');
    const prepared = prepareMicAudio();
    const graph = await createMicAudioGraph(raw as unknown as MediaStreamTrack, prepared);
    const context = contexts[0]!;
    expect((context.createMediaStreamSource.mock.calls[0]?.[0] as unknown as FakeMediaStream).getAudioTracks()).toEqual([raw]);
    const venue = new FakeNode();
    graph.source.connect(venue as unknown as AudioNode);
    expect(graph.streamTrack).toBe(context.outputTrack);
    expect(context.source.connections).toContain(context.highPass);
    expect(context.highPass.connections).toContain(context.compressor);
    expect(context.compressor.connections).toContain(context.destination);
    expect(context.source.connections).toContain(venue);
    expect(context.destination.channelCount).toBe(1);
    expect(context.destination.channelCountMode).toBe('explicit');
    expect(context.highPass.type).toBe('highpass');
    expect(context.highPass.frequency.value).toBe(80);
    expect(context.compressor.threshold.value).toBe(-20);
    expect(context.compressor.ratio.value).toBe(2);
    expect(graph.dspMode).toBe('processed');
    expect(raw.stop).not.toHaveBeenCalled();
    graph.close();
    expect(context.outputTrack.stop).toHaveBeenCalledOnce();
    expect(raw.stop).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
    graph.close();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('bypasses only streaming DSP and keeps venue input connected', async () => {
    const prepared = prepareMicAudio();
    const graph = await createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared);
    const context = contexts[0]!;
    const venue = new FakeNode();
    graph.source.connect(venue as unknown as AudioNode);
    graph.bypassDsp();
    expect(graph.dspMode).toBe('bypass');
    expect(context.source.connections).not.toContain(context.highPass);
    expect(context.source.connections).toContain(context.destination);
    expect(context.source.connections).toContain(venue);
    expect(context.close).not.toHaveBeenCalled();
    graph.bypassDsp();
    expect(context.source.connect).toHaveBeenCalledTimes(4);
  });

  it('uses a dry streaming branch if DSP setup fails', async () => {
    const prepared = prepareMicAudio();
    contexts[0]!.createBiquadFilter.mockImplementationOnce(() => { throw new Error('DSP unavailable'); });
    const graph = await createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared);
    expect(graph.dspMode).toBe('bypass');
    expect(contexts[0]!.source.connections).toContain(contexts[0]!.destination);
    expect(() => graph.close()).not.toThrow();
  });

  it('disconnects a partially initialized DSP graph before falling back', async () => {
    const prepared = prepareMicAudio();
    contexts[0]!.createDynamicsCompressor.mockImplementationOnce(() => { throw new Error('compressor unavailable'); });
    const graph = await createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared);
    expect(graph.dspMode).toBe('bypass');
    expect(contexts[0]!.highPass.disconnect).toHaveBeenCalledOnce();
  });

  it('reads the input level from the shared graph', async () => {
    const prepared = prepareMicAudio();
    contexts[0]!.analyser.getFloatTimeDomainData.mockImplementation((buffer: Float32Array) => buffer.fill(0.5));
    const graph = await createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared);
    expect(graph.level()).toBeGreaterThan(0);
  });

  it('resumes an interrupted context before graph creation', async () => {
    const prepared = prepareMicAudio();
    contexts[0]!.state = 'suspended';
    await createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared);
    expect(contexts[0]!.resume).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing output track and disconnects the incomplete graph', async () => {
    const prepared = prepareMicAudio();
    contexts[0]!.destination.stream.getAudioTracks = () => [];
    await expect(createMicAudioGraph(new FakeTrack('audio') as unknown as MediaStreamTrack, prepared)).rejects.toThrow('配信用の音声トラック');
    expect(contexts[0]!.source.disconnect).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.fetch }));

const { startVenueMic, startVenueSpeaker } = await import('./venueAudio');

const tracks = [{ stop: vi.fn() }] as unknown as MediaStream;
let peers: FakePeer[] = [];
let contexts: FakeAudioContext[] = [];

class FakePeer {
  signalingState = 'stable';
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  channel = { readyState: 'connecting', bufferedAmount: 0, send: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'mic-sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'speaker-sdp' }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description; });
  setRemoteDescription = vi.fn(async () => { this.signalingState = 'have-remote-offer'; });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn(() => { this.signalingState = 'closed'; });
  constructor() { peers.push(this); }
}

class FakeAudioContext {
  destination = {} as AudioNode;
  audioWorklet = { addModule: vi.fn(async (url: string) => { void url; }) };
  close = vi.fn(async () => undefined);
  source = { connect: vi.fn(), disconnect: vi.fn() };
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  processor = { connect: vi.fn(), disconnect: vi.fn(), port: { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() } };
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => this.gain);
  constructor() { contexts.push(this); }
}

beforeEach(() => {
  peers = [];
  contexts = [];
  api.fetch.mockReset().mockImplementation(async (_path: string, options?: { method?: string; schema?: unknown }) =>
    options?.schema ? { type: 'offer', sdp: 'remote-offer' } : null,
  );
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null }; connect = vi.fn(); disconnect = vi.fn(); constructor(context: unknown, name: string, options: unknown) { void context; void name; void options; return contexts[0]!.processor as never; } });
});

afterEach(() => {
  peers.forEach((peer) => peer.close());
  vi.unstubAllGlobals();
});

describe('venue audio', () => {
  it('loads the worklet as a same-origin external asset and wires the mic through a silent monitor', async () => {
    const session = await startVenueMic(tracks);
    const url = contexts[0]!.audioWorklet.addModule.mock.calls[0]![0];

    expect(url).toMatch(/^\/.*venue-pcm\.worklet\.js(?:\?.*)?$/u);
    expect(url).not.toMatch(/^(?:blob|data):/u);
    expect(contexts[0]!.source.connect).toHaveBeenCalledWith(contexts[0]!.processor);
    expect(contexts[0]!.processor.connect).toHaveBeenCalledWith(contexts[0]!.gain);
    expect(contexts[0]!.gain.gain.value).toBe(0);
    expect(api.fetch).toHaveBeenCalledWith('/venue-speaker/mic', expect.objectContaining({ method: 'PUT' }));
    session.close();
  });

  it('resolves the mic session when the peer connects and rejects when it fails', async () => {
    const session = await startVenueMic(tracks);
    let micSettled = false;
    void session.connected.then(() => { micSettled = true; }, () => { micSettled = true; });
    peers[0]!.connectionState = 'connecting';
    peers[0]!.onconnectionstatechange?.();
    await Promise.resolve();
    expect(micSettled).toBe(false);
    const connected = expect(session.connected).resolves.toBeUndefined();
    peers[0]!.connectionState = 'connected';
    peers[0]!.onconnectionstatechange?.();
    await connected;

    const failedSession = await startVenueMic(tracks);
    let failedMicSettled = false;
    void failedSession.connected.then(() => { failedMicSettled = true; }, () => { failedMicSettled = true; });
    peers[1]!.connectionState = 'connecting';
    peers[1]!.onconnectionstatechange?.();
    await Promise.resolve();
    expect(failedMicSettled).toBe(false);
    const failed = expect(failedSession.connected).rejects.toThrow('WebRTC 接続に失敗しました');
    peers[1]!.connectionState = 'failed';
    peers[1]!.onconnectionstatechange?.();
    await failed;
    session.close();
    failedSession.close();
  });

  it('resolves connected when the speaker peer connects and rejects when it fails', async () => {
    const session = await startVenueSpeaker(vi.fn());
    let speakerSettled = false;
    void session.connected.then(() => { speakerSettled = true; }, () => { speakerSettled = true; });
    peers[0]!.connectionState = 'connecting';
    peers[0]!.onconnectionstatechange?.();
    await Promise.resolve();
    expect(speakerSettled).toBe(false);
    const connected = expect(session.connected).resolves.toBeUndefined();
    peers[0]!.connectionState = 'connected';
    peers[0]!.onconnectionstatechange?.();
    await connected;
    session.close();

    const failedSession = await startVenueSpeaker(vi.fn());
    let failedSpeakerSettled = false;
    void failedSession.connected.then(() => { failedSpeakerSettled = true; }, () => { failedSpeakerSettled = true; });
    peers[1]!.connectionState = 'connecting';
    peers[1]!.onconnectionstatechange?.();
    await Promise.resolve();
    expect(failedSpeakerSettled).toBe(false);
    const failed = expect(failedSession.connected).rejects.toThrow('WebRTC 接続に失敗しました');
    peers[1]!.connectionState = 'failed';
    peers[1]!.onconnectionstatechange?.();
    await failed;
    failedSession.close();
  });
});

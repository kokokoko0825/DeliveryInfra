import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  ApiError: class extends Error { constructor(readonly status: number) { super('api error'); } },
}));
vi.mock('@/lib/api', () => ({ apiFetch: api.fetch, ApiError: api.ApiError }));

const { startVenueMic, startVenueSpeaker } = await import('./venueAudio');

const peers: FakePeer[] = [];
const contexts: FakeAudioContext[] = [];
const sessions: Array<{ close: () => void; connected: Promise<void>; getMetrics: () => import('./venueAudio').VenueMetricsSnapshot }> = [];
let participants: Array<{ participantId: string; userId: string; side: 'mic' | 'speaker'; slot: number }> = [];
let offers = new Map<string, { type: 'offer'; sdp: string }>();
let answers = new Map<string, { type: 'answer'; sdp: string }>();
let offerPairs = new Map<string, string>();
let participantNumber = 0;

class FakeChannel {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'blob';
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 'closed'; });
}

class FakePeer {
  signalingState = 'stable';
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  remoteChannel?: FakeChannel;
  remotePair: string | undefined = undefined;
  readonly configuration: RTCConfiguration;
  channel = new FakeChannel();
  createDataChannel = vi.fn((label: string, options?: RTCDataChannelInit) => {
    void label; void options;
    return this.channel as unknown as RTCDataChannel;
  });
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: `offer-${peers.indexOf(this)}` }));
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: `answer-${peers.indexOf(this)}` }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description; });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type === 'offer') this.signalingState = 'have-remote-offer';
    if (description.type === 'answer') this.signalingState = 'stable';
    if (description.type === 'offer') {
      this.remotePair = offerPairs.get(description.sdp!);
      this.remoteChannel = new FakeChannel();
      this.ondatachannel?.({ channel: this.remoteChannel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    }
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn(() => { this.signalingState = 'closed'; this.connectionState = 'closed'; this.onconnectionstatechange?.(); });
  constructor(configuration: RTCConfiguration) { this.configuration = configuration; peers.push(this); }
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = {} as AudioNode;
  audioWorklet = { addModule: vi.fn(async (url: string) => { void url; }) };
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => { this.state = 'running'; });
  source = { connect: vi.fn(), disconnect: vi.fn() };
  trackSources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  trackGains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  processor = { connect: vi.fn(), disconnect: vi.fn(), port: { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() } };
  createMediaStreamSource = vi.fn(() => {
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    this.trackSources.push(node);
    return node as unknown as MediaStreamAudioSourceNode;
  });
  createGain = vi.fn(() => {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.trackGains.push(node);
    return node as unknown as GainNode;
  });
  constructor() { contexts.push(this); }
}

const pairKey = (micSlot: number, speakerSlot: number) => `${micSlot}/${speakerSlot}`;

function transportPacket(micSlot: number, sequence: number, timestamp: number) {
  const buffer = new ArrayBuffer(20 + 960);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x56, 0x50, 0x43, 0x4d]);
  bytes[4] = 1;
  bytes[5] = micSlot;
  const header = new DataView(buffer);
  header.setUint32(8, sequence, true);
  header.setFloat64(12, timestamp, true);
  return buffer;
}

beforeEach(() => {
  peers.length = 0;
  contexts.length = 0;
  sessions.length = 0;
  participants = [];
  offers = new Map();
  answers = new Map();
  offerPairs = new Map();
  participantNumber = 0;
  api.fetch.mockReset().mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    const pair = path.match(/\/(offers|answers)\/(\d+)\/(\d+)$/u);
    if (path.endsWith('/participants') && method === 'GET') return [...participants];
    if (path.endsWith('/participants') && method === 'POST') {
      const body = options?.body as { side: 'mic' | 'speaker'; slot: number };
      if (participants.some((participant) => participant.side === body.side && participant.slot === body.slot)) throw new api.ApiError(409);
      const participant = { participantId: `p${++participantNumber}`, userId: 'test-user', ...body };
      participants.push(participant);
      return { ...participant, expiresAt: new Date().toISOString() };
    }
    if (/\/participants\/[^/]+$/u.test(path) && method === 'DELETE') {
      participants = participants.filter((participant) => participant.participantId !== path.split('/').at(-1));
      return null;
    }
    if (pair) {
      const [, kind, mic, speaker] = pair;
      const key = pairKey(Number(mic), Number(speaker));
      if (method === 'PUT' && kind === 'offers') {
        const offer = options?.body as { type: 'offer'; sdp: string };
        offers.set(key, offer);
        offerPairs.set(offer.sdp, key);
        return null;
      }
      if (method === 'PUT' && kind === 'answers') { answers.set(key, options?.body as { type: 'answer'; sdp: string }); return null; }
      if (method === 'GET' && kind === 'offers') return offers.get(key) ?? null;
      if (method === 'GET' && kind === 'answers') return answers.get(key) ?? null;
    }
    throw new Error(`unexpected API request ${method} ${path}`);
  });
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', class {
    port: FakeAudioContext['processor']['port'];
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(context: FakeAudioContext) { this.port = context.processor.port; return context.processor as never; }
  });
});

afterEach(() => {
  for (const session of sessions) { void session.connected.catch(() => undefined); session.close(); }
  vi.unstubAllGlobals();
});

async function joinMic(slot?: number, transport: 'pcm' | 'audio-track' = 'pcm') {
  const stream = { getAudioTracks: () => [{ kind: 'audio', id: `track-${slot ?? 1}`, addEventListener: vi.fn(), removeEventListener: vi.fn() }] } as unknown as MediaStream;
  const session = await startVenueMic(stream, { ...(slot === undefined ? {} : { slot }), transport });
  void session.connected.catch(() => undefined);
  sessions.push(session);
  return session;
}

async function joinSpeaker(slot?: number, transport: 'pcm' | 'audio-track' = 'pcm') {
  const session = await startVenueSpeaker(vi.fn(), { ...(slot === undefined ? {} : { slot }), transport });
  void session.connected.catch(() => undefined);
  sessions.push(session);
  return session;
}

async function waitForLinks(count: number) {
  await vi.waitFor(() => expect(peers).toHaveLength(count * 2), { timeout: 3000, interval: 20 });
  await vi.waitFor(() => expect(offers.size).toBe(count), { timeout: 3000, interval: 20 });
  await vi.waitFor(() => expect(answers.size).toBe(count), { timeout: 3000, interval: 20 });
}

describe('venue room audio transport', () => {
  it('resumes the speaker AudioContext before waiting for signaling API calls', async () => {
    const pending = startVenueSpeaker(vi.fn());
    void pending.catch(() => undefined);
    void pending.then((session) => session.connected.catch(() => undefined));
    const resumedBeforeAwait = contexts[0]?.resume.mock.calls.length === 1;
    const apiWasStillIdle = api.fetch.mock.calls.length === 0;
    const session = await pending;
    try {
      expect(resumedBeforeAwait).toBe(true);
      expect(apiWasStillIdle).toBe(true);
      expect(api.fetch).toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it.each([
    { name: 'one-to-many', micCount: 1, speakerCount: 2, pairs: 2 },
    { name: 'many-to-many', micCount: 2, speakerCount: 2, pairs: 4 },
  ])('sets up $name direct audio-track links and cleans playback nodes', async ({ micCount, speakerCount, pairs }) => {
    for (let index = 0; index < micCount; index++) await joinMic(undefined, 'audio-track');
    for (let index = 0; index < speakerCount; index++) await joinSpeaker(undefined, 'audio-track');
    await waitForLinks(pairs);
    expect(peers.filter((peer) => peer.addTrack.mock.calls.length > 0)).toHaveLength(pairs);
    expect(peers.filter((peer) => peer.createDataChannel.mock.calls.length > 0).every((peer) => peer.createDataChannel.mock.calls[0]?.[0] === 'control')).toBe(true);
    expect(peers.every((peer) => peer.configuration.iceServers?.length === 0)).toBe(true);
    expect(sessions.every((session) => session.getMetrics().transport === 'audio-track')).toBe(true);
    expect(sessions.slice(0, micCount).every((session) => session.getMetrics().sentPackets === 0)).toBe(true);
    expect(contexts.every((context) => context.audioWorklet.addModule.mock.calls.length === 0)).toBe(true);

    const speakerPeers = peers.filter((peer) => peer.remoteChannel);
    for (const peer of speakerPeers) {
      const track = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack;
      peer.ontrack?.({ track, streams: [{} as MediaStream] } as unknown as RTCTrackEvent);
    }
    const audioContexts = contexts;
    expect(audioContexts.reduce((sum, context) => sum + context.trackSources.length, 0)).toBe(pairs);
    expect(audioContexts.flatMap((context) => context.trackSources).every((node) => node.connect.mock.calls.length === 1)).toBe(true);
    expect(audioContexts.flatMap((context) => context.trackGains).map((gain) => gain.gain.value)).toEqual(Array(pairs).fill(1 / 3));
    expect(audioContexts.flatMap((context) => context.trackGains).every((gain) => gain.connect.mock.calls.length === 1)).toBe(true);
    for (const speaker of sessions.slice(micCount)) speaker.close();
    expect(audioContexts.flatMap((context) => context.trackSources).every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(audioContexts.flatMap((context) => context.trackGains).every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);
    expect(api.fetch.mock.calls.some(([path]) => /relay|turn:|stun:/iu.test(String(path)))).toBe(false);
  });

  it('connects one mic directly to one speaker using signaling-only API without relay servers', async () => {
    await joinMic();
    await joinSpeaker();
    await waitForLinks(1);
    expect(offers.get('1/1')?.type).toBe('offer');
    expect(answers.get('1/1')?.type).toBe('answer');
    expect(peers.every((peer) => peer.configuration.iceServers?.length === 0)).toBe(true);
    expect(api.fetch.mock.calls.every(([path]) => String(path).includes('/venue-speaker/rooms/venue-poc/'))).toBe(true);
    expect(api.fetch.mock.calls.some(([path]) => /relay|turn:|stun:/iu.test(String(path)))).toBe(false);
    contexts[0]!.processor.port.onmessage?.({ data: new ArrayBuffer(960) } as MessageEvent);
    const outgoingChannel = peers.find((peer) => peer.createDataChannel.mock.calls.length > 0)!.channel;
    const outgoingPacket = outgoingChannel.send.mock.calls[0]![0] as ArrayBuffer;
    const outgoingHeader = new DataView(outgoingPacket);
    expect(new Uint8Array(outgoingPacket, 0, 4)).toEqual(new Uint8Array([0x56, 0x50, 0x43, 0x4d]));
    expect(new Uint8Array(outgoingPacket)[5]).toBe(1);
    expect(outgoingHeader.getUint32(8, true)).toBe(0);
    expect(outgoingPacket.byteLength).toBe(980);
    const micSnapshot = sessions[0]!.getMetrics();
    expect(micSnapshot).toMatchObject({ role: 'mic', slot: 1, transport: 'pcm', activePeers: 1, connectedPeers: 0, sentPackets: 1, sentBytes: 960 });
    expect(micSnapshot.peers[0]).toMatchObject({ peerId: '1:1', side: 'speaker', slot: 1, micSlot: 1, speakerSlot: 1, active: true, sentPackets: 1, sentBytes: 960 });
    expect(Object.isFrozen(micSnapshot)).toBe(true);
    const receiver = peers.find((peer) => peer.remoteChannel);
    receiver!.remoteChannel!.onmessage?.({ data: transportPacket(1, 7, 1234) } as MessageEvent);
    receiver!.remoteChannel!.onmessage?.({ data: transportPacket(1, 7, 1244) } as MessageEvent);
    receiver!.remoteChannel!.onmessage?.({ data: transportPacket(1, 9, 1254) } as MessageEvent);
    receiver!.remoteChannel!.onmessage?.({ data: new ArrayBuffer(12) } as MessageEvent);
    expect(contexts[1]!.processor.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'enqueue', micId: 'mic-1', sequence: 7, timestamp: 1234 }),
      expect.any(Array),
    );
    contexts[1]!.processor.port.onmessage?.({ data: { type: 'stats', streams: [{ micId: 'mic-1', queuedMs: 8, underflows: 3, overflows: 2, dropped: 4, peak: 0.75 }] } } as MessageEvent);
    const speakerSnapshot = sessions[1]!.getMetrics();
    expect(speakerSnapshot).toMatchObject({ role: 'speaker', receivedPackets: 3, receivedBytes: 2880, sequenceGaps: 1, duplicates: 1, invalidPackets: 1 });
    expect(speakerSnapshot.peers[0]).toMatchObject({ peerId: '1:1', side: 'mic', slot: 1, micSlot: 1, speakerSlot: 1, receivedPackets: 3, sequenceGaps: 1, duplicates: 1, invalidPackets: 1 });
    expect(speakerSnapshot.workletStreams).toEqual([{ micId: 'mic-1', queuedMs: 8, underflows: 3, overflows: 2, dropped: 4, peak: 0.75 }]);
    receiver!.remoteChannel!.onmessage?.({ data: JSON.stringify({ kind: 'pong', at: performance.now() - 20 }) } as MessageEvent);
    expect(sessions[1]!.getMetrics().peers[0]!.rttMs).toBeGreaterThan(0);
    for (const peer of peers) { peer.connectionState = 'connected'; peer.onconnectionstatechange?.(); }
    await expect(sessions[0]!.connected).resolves.toBeUndefined();
    expect(sessions[0]!.getMetrics()).toMatchObject({ connectedPeers: 1, peers: [{ active: true, connected: true, state: 'connected' }] });
  });

  it('fans one mic out to multiple speakers and recreates a failed direct peer', async () => {
    await joinMic();
    await joinSpeaker();
    await joinSpeaker();
    await waitForLinks(2);
    expect(offers.has('1/1')).toBe(true);
    expect(offers.has('1/2')).toBe(true);
    contexts[0]!.processor.port.onmessage?.({ data: new ArrayBuffer(960) } as MessageEvent);
    const micSnapshot = sessions[0]!.getMetrics();
    expect(micSnapshot.sentPackets).toBe(1);
    expect(micSnapshot.peers.map((peer) => peer.sentPackets)).toEqual([1, 1]);
    expect(micSnapshot.peers.reduce((sum, peer) => sum + peer.sentPackets, 0)).toBe(2);
    const micLinks = peers.filter((peer) => peer.createDataChannel.mock.calls.length > 0);
    micLinks[0]!.channel.bufferedAmount = 64_000;
    contexts[0]!.processor.port.onmessage?.({ data: new ArrayBuffer(960) } as MessageEvent);
    const afterDrop = sessions[0]!.getMetrics();
    expect(afterDrop.sentPackets).toBe(2);
    expect(afterDrop.backpressureDrops).toBe(1);
    expect(afterDrop.peers.reduce((sum, peer) => sum + peer.sentPackets, 0)).toBe(3);
    peers[0]!.connectionState = 'failed';
    peers[0]!.onconnectionstatechange?.();
    await vi.waitFor(() => expect(peers.length).toBeGreaterThan(4), { timeout: 3000, interval: 30 });
    expect(peers.slice(4).every((peer) => peer.configuration.iceServers?.length === 0)).toBe(true);
  });

  it('rejects the connection promise and closes links when every initial peer fails', async () => {
    await joinMic();
    await joinSpeaker();
    await waitForLinks(1);
    const failed = sessions.map((session) => expect(session.connected).rejects.toThrow('WebRTC 接続に失敗しました'));
    for (const peer of peers) { peer.connectionState = 'failed'; peer.onconnectionstatechange?.(); }
    await Promise.all(failed);
    expect(peers.every((peer) => peer.signalingState === 'closed')).toBe(true);
  });

  it('connects every mic to every speaker and removes its participant and peers on close', async () => {
    await joinMic();
    await joinMic();
    await joinSpeaker();
    await joinSpeaker();
    await waitForLinks(4);
    expect([...offers.keys()].sort()).toEqual(['1/1', '1/2', '2/1', '2/2']);
    expect([...answers.keys()].sort()).toEqual(['1/1', '1/2', '2/1', '2/2']);
    const speakerOneChannels = peers.filter((peer) => peer.remoteChannel && peer.remotePair?.endsWith('/1'));
    const micOne = speakerOneChannels.find((peer) => peer.remotePair?.startsWith('1/'))!;
    const micTwo = speakerOneChannels.find((peer) => peer.remotePair?.startsWith('2/'))!;
    micOne.remoteChannel!.onmessage?.({ data: transportPacket(1, 4, 100) } as MessageEvent);
    micOne.remoteChannel!.onmessage?.({ data: transportPacket(1, 6, 120) } as MessageEvent);
    micTwo.remoteChannel!.onmessage?.({ data: transportPacket(2, 10, 100) } as MessageEvent);
    micTwo.remoteChannel!.onmessage?.({ data: transportPacket(2, 11, 110) } as MessageEvent);
    micTwo.remoteChannel!.onmessage?.({ data: transportPacket(2, 11, 120) } as MessageEvent);
    const speakerMetrics = sessions[2]!.getMetrics();
    expect(speakerMetrics.peers.find((peer) => peer.slot === 1)).toMatchObject({ receivedPackets: 2, sequenceGaps: 1, duplicates: 0 });
    expect(speakerMetrics.peers.find((peer) => peer.slot === 2)).toMatchObject({ receivedPackets: 3, sequenceGaps: 0, duplicates: 1 });
    expect(speakerMetrics.receivedPackets).toBe(5);
    const before = participants.length;
    sessions[0]!.close();
    await vi.waitFor(() => expect(participants.length).toBe(before - 1), { timeout: 1000, interval: 20 });
    await vi.waitFor(() => expect(peers.filter((peer) => peer.signalingState === 'closed').length).toBeGreaterThanOrEqual(2), { timeout: 1000, interval: 20 });
  });

  it('rejects unavailable explicit slots and automatically reserves a free slot', async () => {
    participants.push({ participantId: 'occupied', userId: 'other', side: 'mic', slot: 1 });
    await expect(joinMicExplicit(1)).rejects.toThrow();
    const session = await joinMic();
    expect(participants.some((participant) => participant.participantId === 'p1' && participant.slot === 2)).toBe(true);
    session.close();
  });

  it('disconnects track nodes when a speaker expires and cleans the replacement on close', async () => {
    await joinMic(undefined, 'audio-track');
    await joinSpeaker(undefined, 'audio-track');
    await waitForLinks(1);
    const oldReceiver = peers.find((peer) => peer.remoteChannel)!;
    oldReceiver.ontrack?.({ track: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack, streams: [{} as MediaStream] } as unknown as RTCTrackEvent);
    const oldSource = contexts[0]!.trackSources[0]!;
    const oldGain = contexts[0]!.trackGains[0]!;
    expect(oldGain.gain.value).toBe(1 / 3);
    const oldSpeakerId = participants.find((participant) => participant.side === 'speaker')!.participantId;
    participants = participants.filter((participant) => participant.participantId !== oldSpeakerId);
    await joinSpeaker(1, 'audio-track');
    await vi.waitFor(() => expect(peers.length).toBeGreaterThan(2), { timeout: 3000, interval: 30 });
    await vi.waitFor(() => expect(offers.has('1/1')).toBe(true), { timeout: 1000, interval: 20 });
    expect(participants.filter((participant) => participant.side === 'speaker')).toHaveLength(1);
    await vi.waitFor(() => expect(peers.some((peer) => peer.signalingState === 'closed')).toBe(true), { timeout: 1500, interval: 20 });
    expect(oldSource.disconnect).toHaveBeenCalledTimes(1);
    expect(oldGain.disconnect).toHaveBeenCalledTimes(1);
    const replacementReceiver = peers.filter((peer) => peer.remoteChannel).at(-1)!;
    replacementReceiver.ontrack?.({ track: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack, streams: [{} as MediaStream] } as unknown as RTCTrackEvent);
    const replacementContext = contexts.at(-1)!;
    expect(replacementContext.trackGains[0]!.gain.value).toBe(1 / 3);
    sessions.at(-1)!.close();
    expect(replacementContext.trackSources[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(replacementContext.trackGains[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});

function joinMicExplicit(slot: number) {
  return startVenueMic({} as MediaStream, { slot });
}

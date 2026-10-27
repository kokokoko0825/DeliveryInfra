import { ApiError, apiFetch } from '@/lib/api';
import venuePcmWorkletUrl from './venue-pcm.worklet.js?url&no-inline';
import { recordClientDiagnostic } from '@/lib/diagnostics';

type Signal = { type: 'offer' | 'answer'; sdp: string };
type Side = 'mic' | 'speaker';
type Participant = { participantId: string; userId: string; side: Side; slot: number };
type Registration = { participantId: string; side: Side; slot: number; expiresAt: string };
type ParticipantOptions = { roomId?: string; slot?: number };
export type VenueTransport = 'pcm' | 'audio-track';
type TransportOptions = ParticipantOptions & { transport?: VenueTransport; onLeaseLost?: () => void };
export type VenuePeerMetrics = Readonly<{
  peerId: string;
  side: Side;
  slot: number;
  micSlot: number;
  speakerSlot: number;
  active: boolean;
  state: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  connected: boolean;
  sentPackets: number;
  sentBytes: number;
  backpressureDrops: number;
  receivedPackets: number;
  receivedBytes: number;
  sequenceGaps: number;
  duplicates: number;
  invalidPackets: number;
  rttMs: number | null;
}>;
export type VenueWorkletStreamMetrics = Readonly<{
  micId: string;
  queuedMs: number;
  underflows: number;
  overflows: number;
  dropped: number;
  peak: number;
}>;
export type VenueMetricsSnapshot = Readonly<{
  role: Side;
  slot: number;
  transport: VenueTransport;
  activePeers: number;
  connectedPeers: number;
  /** Unique PCM frames read from the mic worklet, counted once before fan-out. */
  sentPackets: number;
  sentBytes: number;
  backpressureDrops: number;
  receivedPackets: number;
  receivedBytes: number;
  sequenceGaps: number;
  duplicates: number;
  invalidPackets: number;
  rttMs: number | null;
  peers: readonly VenuePeerMetrics[];
  workletStreams: readonly VenueWorkletStreamMetrics[];
}>;
export type VenueSessionMetrics = VenueMetricsSnapshot;
type PeerCounters = {
  sentPackets: number; sentPcmBytes: number; bufferedAmountDrops: number;
  receivedPackets: number; receivedPcmBytes: number; sequenceGaps: number; duplicates: number; invalidPackets: number;
  rttMs: number | null; highestSequence: number; seenSequences: Set<number>;
};
type Link = { peer: RTCPeerConnection; remoteParticipantId: string; micSlot: number; speakerSlot: number; channel?: RTCDataChannel; disconnectTimer: ReturnType<typeof setTimeout> | undefined; connectTimer: ReturnType<typeof setTimeout> | undefined; metrics: PeerCounters };
type AudioController = {
  close: () => void;
  onPcm?: (micId: string, sequence: number, timestamp: number, data: ArrayBuffer) => void;
  setPcmSender?: (send: (data: ArrayBuffer) => void) => void;
  getWorkletStreams?: () => readonly VenueWorkletStreamMetrics[];
  onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => (() => void) | undefined;
};

function reportDataChannelFailure(error: unknown, phase: string, role: Side, transport: VenueTransport, link: Link) {
  recordClientDiagnostic(error, 'venue.data-channel', {
    phase, role, transport, peerId: `${link.micSlot}:${link.speakerSlot}`,
    micSlot: link.micSlot, speakerSlot: link.speakerSlot,
    readyState: link.channel?.readyState ?? null, bufferedAmount: link.channel?.bufferedAmount ?? null,
  });
}

const ROOM_ID = 'venue-live';
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const DISCOVERY_INTERVAL_MS = 750;
const SIGNAL_INTERVAL_MS = 300;
const MAX_SIGNAL_POLLS = 300;
const LEASE_RENEW_INTERVAL_MS = 120_000;
const PCM_HEADER_BYTES = 20;
const PCM_BYTES = 960;
const MAX_BUFFERED_PCM_BYTES = (PCM_HEADER_BYTES + PCM_BYTES) * 4;
const MAX_SEQUENCE_HISTORY = 256;
const PCM_MAGIC = [0x56, 0x50, 0x43, 0x4d]; // VPCM
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError';
const roomPath = (roomId: string) => `/venue-speaker/rooms/${encodeURIComponent(roomId)}`;
const pairPath = (kind: 'offers' | 'answers', micSlot: number, speakerSlot: number) => `${kind}/${micSlot}/${speakerSlot}`;
const signalSchema = { parse: (value: unknown) => {
  if (value === null) return null;
  if (typeof value !== 'object' || !value || !('type' in value) || !('sdp' in value)) throw new Error('シグナリング応答が不正です');
  const signal = value as Signal;
  if ((signal.type !== 'offer' && signal.type !== 'answer') || typeof signal.sdp !== 'string') throw new Error('シグナリング応答が不正です');
  return signal;
} };

async function listParticipants(roomId: string) {
  return apiFetch<Participant[]>(`${roomPath(roomId)}/participants`, { schema: { parse: (value) => Array.isArray(value) ? value as Participant[] : [] } });
}

async function registerParticipant(side: Side, options: ParticipantOptions): Promise<Registration> {
  const roomId = options.roomId ?? ROOM_ID;
  const maxSlot = side === 'mic' ? 3 : 5;
  const slots = options.slot !== undefined ? [options.slot] : Array.from({ length: maxSlot }, (_, index) => index + 1);
  if (slots.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > maxSlot)) throw new Error(`${side} slot が不正です`);
  const existing = await listParticipants(roomId);
  const occupied = new Set(existing.filter((participant) => participant.side === side).map((participant) => participant.slot));
  let lastError: unknown;
  for (const slot of slots) {
    if (options.slot === undefined && occupied.has(slot)) continue;
    try {
      return await apiFetch<Registration>(`${roomPath(roomId)}/participants`, { method: 'POST', body: { side, slot }, schema: { parse: (value) => value as Registration } });
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.status === 409 && options.slot === undefined) continue;
      throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`${side === 'mic' ? 'マイク' : 'スピーカー'}の空きスロットがありません`);
}

function waitIce(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (timedOut: boolean) => {
      peer.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timeout);
      resolve(timedOut);
    };
    const check = () => { if (peer.iceGatheringState === 'complete') done(false); };
    const timeout = setTimeout(() => done(true), 8000);
    peer.addEventListener('icegatheringstatechange', check);
  });
}

async function pollSignal(roomId: string, path: string, peer: RTCPeerConnection, isClosed: () => boolean) {
  for (let attempt = 0; attempt < MAX_SIGNAL_POLLS; attempt++) {
    if (isClosed() || peer.signalingState === 'closed') throw new Error('接続が終了しました');
    const signal = await apiFetch<Signal | null>(`${roomPath(roomId)}/${path}`, { schema: signalSchema });
    if (signal) return signal;
    await sleep(SIGNAL_INTERVAL_MS);
  }
  throw new Error('シグナリングが期限切れです');
}

function readControlMessage(value: unknown): { kind?: string; at?: number } | null {
  if (typeof value !== 'string') return null;
  try {
    const message = JSON.parse(value) as { kind?: string; at?: number };
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}

function encodePcmPacket(micSlot: number, sequence: number, timestamp: number, pcm: ArrayBuffer) {
  const packet = new ArrayBuffer(PCM_HEADER_BYTES + pcm.byteLength);
  const bytes = new Uint8Array(packet);
  bytes.set(PCM_MAGIC);
  bytes[4] = 1;
  bytes[5] = micSlot;
  const header = new DataView(packet);
  header.setUint32(8, sequence, true);
  header.setFloat64(12, timestamp, true);
  bytes.set(new Uint8Array(pcm), PCM_HEADER_BYTES);
  return packet;
}

function decodePcmPacket(data: ArrayBuffer, micSlot: number) {
  if (data.byteLength !== PCM_HEADER_BYTES + PCM_BYTES) return null;
  const bytes = new Uint8Array(data, 0, PCM_HEADER_BYTES);
  if (!PCM_MAGIC.every((value, index) => bytes[index] === value) || bytes[4] !== 1 || bytes[5] !== micSlot) return null;
  const header = new DataView(data, 0, PCM_HEADER_BYTES);
  const sequence = header.getUint32(8, true);
  const timestamp = header.getFloat64(12, true);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  return { sequence, timestamp, pcm: data.slice(PCM_HEADER_BYTES) };
}

function startPings(channel: RTCDataChannel, onRtt: (value: number) => void, onSendFailure: (error: unknown, phase: string) => void) {
  const interval = setInterval(() => {
    if (channel.readyState === 'open') {
      try { channel.send(JSON.stringify({ kind: 'ping', at: performance.now() })); }
      catch (error) { onSendFailure(error, 'control-ping'); }
    }
  }, 1000);
  channel.onmessage = ({ data }) => {
    const message = readControlMessage(data);
    if (!message) return;
    if (message.kind === 'ping' && message.at !== undefined && channel.readyState === 'open') {
      try { channel.send(JSON.stringify({ kind: 'pong', at: message.at })); }
      catch (error) { onSendFailure(error, 'control-pong'); }
    } else if (message.kind === 'pong' && message.at !== undefined) {
      onRtt(performance.now() - message.at);
    }
  };
  return () => clearInterval(interval);
}

function createPeerCounters(): PeerCounters {
  return { sentPackets: 0, sentPcmBytes: 0, bufferedAmountDrops: 0, receivedPackets: 0, receivedPcmBytes: 0, sequenceGaps: 0, duplicates: 0, invalidPackets: 0, rttMs: null, highestSequence: -1, seenSequences: new Set() };
}

function createSession(
  side: Side,
  registration: Registration,
  roomId: string,
  onRtt: (value: number) => void,
  setupAudio: () => AudioController,
  transport: VenueTransport = 'pcm',
  micStream?: MediaStream,
  onLeaseLost?: () => void,
): VenueSession {
  const links = new Map<string, Link>();
  const peerHistory = new Map<string, PeerCounters>();
  const peerParticipantIds = new Map<string, string>();
  const retryAfter = new Map<string, number>();
  const retryCounts = new Map<string, number>();
  const pingCleanups = new Map<RTCDataChannel, () => void>();
  const trackCleanups = new Map<string, Array<() => void>>();
  let closed = false;
  let latestRtt: number | null = null;
  const audio = setupAudio();
  let sentPackets = 0;
  let sentPcmBytes = 0;
  let connectedResolve!: () => void;
  let connectedReject!: (error: Error) => void;
  let connectedSettled = false;
  const connected = new Promise<void>((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  // A caller may close while startVenueMic is still returning the session.
  void connected.catch(() => undefined);
  const updateRtt = (link: Link, value: number) => { latestRtt = value; link.metrics.rttMs = value; onRtt(value); };

  const closeLink = (key: string, link: Link) => {
    if (links.get(key) !== link) return;
    links.delete(key);
    if (link.disconnectTimer) clearTimeout(link.disconnectTimer);
    if (link.connectTimer) clearTimeout(link.connectTimer);
    for (const cleanup of trackCleanups.get(key) ?? []) cleanup();
    trackCleanups.delete(key);
    if (link.channel) {
      pingCleanups.get(link.channel)?.();
      pingCleanups.delete(link.channel);
      link.channel.close();
    }
    link.metrics.rttMs = null;
    link.peer.close();
  };

  const connectPair = (remote: Participant) => {
    const mic = side === 'mic' ? registration : remote;
    const speaker = side === 'speaker' ? registration : remote;
    const key = `${mic.slot}:${speaker.slot}`;
    let metrics = peerHistory.get(key);
    if (!metrics) {
      metrics = createPeerCounters();
      peerHistory.set(key, metrics);
    } else if (peerParticipantIds.get(key) !== remote.participantId) {
      metrics.highestSequence = -1;
      metrics.seenSequences.clear();
    }
    peerParticipantIds.set(key, remote.participantId);
    const link: Link = { peer: new RTCPeerConnection({ iceServers: ICE_SERVERS }), remoteParticipantId: remote.participantId, micSlot: mic.slot, speakerSlot: speaker.slot, disconnectTimer: undefined, connectTimer: undefined, metrics };
    links.set(key, link);
    const peer = link.peer;
    const reportChannelSendFailure = (error: unknown, phase: string) => reportDataChannelFailure(error, phase, side, transport, link);
    const peerContext = (phase: string) => ({
      phase, role: side, transport, peerId: key, micSlot: mic.slot, speakerSlot: speaker.slot,
      connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState,
      iceGatheringState: peer.iceGatheringState, signalingState: peer.signalingState,
      retryAttempt: retryCounts.get(key) ?? 0,
    });
    const reportPeerFailure = (phase: string, error: unknown) => {
      const context = peerContext(phase);
      if (typeof peer.getStats !== 'function') {
        recordClientDiagnostic(error, 'venue.peer', context);
        return;
      }
      void peer.getStats().then((stats) => {
        const reports = [...stats.values()];
        const pair = reports.map((stat) => stat as RTCIceCandidatePairStats).find((stat) => stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded');
        const local = pair ? stats.get(pair.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined : undefined;
        const remoteCandidate = pair ? stats.get(pair.remoteCandidateId) as (RTCStats & { candidateType?: string }) | undefined : undefined;
        recordClientDiagnostic(error, 'venue.peer', {
          ...context,
          candidatePairState: pair?.state ?? null,
          localCandidateType: local?.candidateType ?? null,
          remoteCandidateType: remoteCandidate?.candidateType ?? null,
        });
      }).catch(() => recordClientDiagnostic(error, 'venue.peer', context));
    };
    const delayRetry = () => {
      const count = (retryCounts.get(key) ?? 0) + 1;
      retryCounts.set(key, count);
      retryAfter.set(key, Date.now() + Math.min(30_000, 1_000 * (2 ** Math.min(count - 1, 5))));
    };
    link.connectTimer = setTimeout(() => {
      if (peer.connectionState === 'connected' || links.get(key) !== link) return;
      delayRetry();
      reportPeerFailure('connection-timeout', new Error('WebRTC peer did not connect within 30 seconds'));
      closeLink(key, link);
    }, 30_000);
    peer.ontrack = ({ track, streams }) => {
      const cleanup = audio.onTrack?.(track, streams);
      if (cleanup) trackCleanups.set(key, [...(trackCleanups.get(key) ?? []), cleanup]);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        if (link.disconnectTimer) clearTimeout(link.disconnectTimer);
        if (link.connectTimer) clearTimeout(link.connectTimer);
        link.connectTimer = undefined;
        link.disconnectTimer = undefined;
        retryAfter.delete(key);
        retryCounts.delete(key);
        if (!connectedSettled) { connectedSettled = true; connectedResolve(); }
      } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        if (peer.connectionState === 'failed') {
          delayRetry();
          reportPeerFailure('connection-failed', new Error(`WebRTC connection failed for ${key}`));
        }
        closeLink(key, link);
      } else if (peer.connectionState === 'disconnected' && !link.disconnectTimer) {
        link.disconnectTimer = setTimeout(() => {
          if (peer.connectionState === 'disconnected') closeLink(key, link);
        }, 3000);
      }
    };
    peer.onicecandidateerror = (event) => {
      recordClientDiagnostic(new Error(event.errorText || 'ICE server candidate gathering failed'), 'venue.ice-candidate', {
        role: side, transport, peerId: key, micSlot: mic.slot, speakerSlot: speaker.slot,
        errorCode: event.errorCode, url: event.url, iceGatheringState: peer.iceGatheringState,
      });
    };

    if (side === 'mic') {
      if (transport === 'audio-track') {
        for (const track of micStream?.getAudioTracks() ?? []) peer.addTrack(track, micStream!);
      }
      const channel = transport === 'pcm'
        ? peer.createDataChannel('pcm', { ordered: false, maxRetransmits: 0 })
        : peer.createDataChannel('control');
      link.channel = channel;
      pingCleanups.set(channel, startPings(channel, (value) => updateRtt(link, value), reportChannelSendFailure));
      void (async () => {
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          const iceTimedOut = await waitIce(peer);
          if (iceTimedOut) recordClientDiagnostic(new Error('ICE candidate gathering timed out after 8 seconds'), 'venue.ice-gathering', peerContext('offer'));
          if (closed || peer.signalingState === 'closed') return;
          const local = peer.localDescription;
          if (!local?.sdp) throw new Error('WebRTC offer を作成できませんでした');
          await apiFetch(`${roomPath(roomId)}/${pairPath('offers', mic.slot, speaker.slot)}`, { method: 'PUT', body: { type: 'offer', sdp: local.sdp } });
          // Let the speaker's participant poll replace any answer left by a previous peer.
          await sleep(DISCOVERY_INTERVAL_MS * 2);
          const answer = await pollSignal(roomId, pairPath('answers', mic.slot, speaker.slot), peer, () => closed || links.get(key) !== link);
          await peer.setRemoteDescription(answer);
        } catch (error) {
          if (closed || links.get(key) !== link || isAbortError(error)) return;
          delayRetry();
          reportPeerFailure('offer', error);
          closeLink(key, link);
        }
      })();
    } else {
      peer.ondatachannel = ({ channel }) => {
        channel.binaryType = 'arraybuffer';
        link.channel = channel;
        pingCleanups.set(channel, startPings(channel, (value) => updateRtt(link, value), reportChannelSendFailure));
        if (transport === 'audio-track') return;
        channel.onmessage = ({ data }) => {
          if (data instanceof ArrayBuffer) {
            const packet = decodePcmPacket(data, mic.slot);
            if (!packet) {
              link.metrics.invalidPackets++;
              return;
            }
            link.metrics.receivedPackets++;
            link.metrics.receivedPcmBytes += packet.pcm.byteLength;
            if (link.metrics.seenSequences.has(packet.sequence) || packet.sequence + MAX_SEQUENCE_HISTORY < link.metrics.highestSequence) {
              link.metrics.duplicates++;
              return;
            }
            if (link.metrics.highestSequence >= 0 && packet.sequence > link.metrics.highestSequence + 1) {
              link.metrics.sequenceGaps += packet.sequence - link.metrics.highestSequence - 1;
            }
            link.metrics.highestSequence = Math.max(link.metrics.highestSequence, packet.sequence);
            link.metrics.seenSequences.add(packet.sequence);
            for (const sequence of link.metrics.seenSequences) {
              if (sequence + MAX_SEQUENCE_HISTORY < link.metrics.highestSequence) link.metrics.seenSequences.delete(sequence);
            }
            audio.onPcm?.(`mic-${mic.slot}`, packet.sequence, packet.timestamp, packet.pcm);
            return;
          }
          const message = readControlMessage(data);
          if (!message) return;
          if (message.kind === 'ping' && message.at !== undefined && channel.readyState === 'open') {
            try { channel.send(JSON.stringify({ kind: 'pong', at: message.at })); }
            catch (error) { reportChannelSendFailure(error, 'control-pong'); }
          }
          else if (message.kind === 'pong' && message.at !== undefined) updateRtt(link, performance.now() - message.at);
        };
      };
      void (async () => {
        try {
          const offer = await pollSignal(roomId, pairPath('offers', mic.slot, speaker.slot), peer, () => closed || links.get(key) !== link);
          await peer.setRemoteDescription(offer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          const iceTimedOut = await waitIce(peer);
          if (iceTimedOut) recordClientDiagnostic(new Error('ICE candidate gathering timed out after 8 seconds'), 'venue.ice-gathering', peerContext('answer'));
          if (closed || peer.signalingState === 'closed') return;
          const local = peer.localDescription;
          if (!local?.sdp) throw new Error('WebRTC answer を作成できませんでした');
          await apiFetch(`${roomPath(roomId)}/${pairPath('answers', mic.slot, speaker.slot)}`, { method: 'PUT', body: { type: 'answer', sdp: local.sdp } });
          while (!closed && links.get(key) === link) {
            await sleep(DISCOVERY_INTERVAL_MS);
            if (closed || links.get(key) !== link) break;
            const latestOffer = await apiFetch<Signal | null>(`${roomPath(roomId)}/${pairPath('offers', mic.slot, speaker.slot)}`, { schema: signalSchema });
            if (latestOffer && latestOffer.sdp !== offer.sdp) {
              closeLink(key, link);
              break;
            }
          }
        } catch (error) {
          if (closed || links.get(key) !== link || isAbortError(error)) return;
          delayRetry();
          reportPeerFailure('answer', error);
          closeLink(key, link);
        }
      })();
    }
  };

  const discover = async () => {
    if (closed) return;
    try {
      const participants = await listParticipants(roomId);
      const own = participants.find((participant) => participant.participantId === registration.participantId);
      if (!own) {
        close();
        onLeaseLost?.();
        return;
      }
      const remotes = participants.filter((participant) => participant.participantId !== registration.participantId && participant.side !== side);
      for (const [key, link] of links) {
        const remote = remotes.find((participant) => {
          const micSlot = side === 'mic' ? registration.slot : participant.slot;
          const speakerSlot = side === 'speaker' ? registration.slot : participant.slot;
          return key === `${micSlot}:${speakerSlot}`;
        });
        if (!remote || remote.participantId !== link.remoteParticipantId) closeLink(key, link);
      }
      for (const remote of remotes) {
        const micSlot = side === 'mic' ? registration.slot : remote.slot;
        const speakerSlot = side === 'speaker' ? registration.slot : remote.slot;
        const key = `${micSlot}:${speakerSlot}`;
        const current = links.get(key);
        if (retryAfter.get(key) && retryAfter.get(key)! > Date.now()) continue;
        if (!current || current.remoteParticipantId !== remote.participantId) connectPair(remote);
      }
    } catch (error) {
      if (!closed && !isAbortError(error)) recordClientDiagnostic(error, 'venue.discovery', { phase: 'participant-poll', role: side, transport, slot: registration.slot });
      // A failed discovery poll is transient; the next interval retries.
    }
  };

  audio.setPcmSender?.((data) => {
    sentPackets++;
    sentPcmBytes += data.byteLength - PCM_HEADER_BYTES;
    for (const link of links.values()) {
      if (link.channel?.readyState !== 'open') continue;
      if (link.channel.bufferedAmount >= MAX_BUFFERED_PCM_BYTES) {
        link.metrics.bufferedAmountDrops++;
        continue;
      }
      try {
        link.channel.send(data);
        link.metrics.sentPackets++;
        link.metrics.sentPcmBytes += data.byteLength - PCM_HEADER_BYTES;
      } catch (error) {
        reportDataChannelFailure(error, 'send-exception', side, transport, link);
      }
    }
  });
  const discovery = setInterval(() => { void discover(); }, DISCOVERY_INTERVAL_MS);
  const renewal = setInterval(() => {
    void apiFetch(`${roomPath(roomId)}/participants/${registration.participantId}`, { method: 'PATCH' }).catch((error) => {
      if (error instanceof ApiError && error.status === 404) { close(); onLeaseLost?.(); }
      else if (!closed && !isAbortError(error)) recordClientDiagnostic(error, 'venue.lease', { phase: 'renewal', role: side, transport, slot: registration.slot, status: error instanceof ApiError ? error.status : null });
    });
  }, LEASE_RENEW_INTERVAL_MS);
  void discover();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(discovery);
    clearInterval(renewal);
    for (const [key, link] of links) closeLink(key, link);
    audio.close();
    if (!connectedSettled) {
      connectedSettled = true;
      connectedReject(new Error('接続が終了しました'));
    }
    void apiFetch(`${roomPath(roomId)}/participants/${registration.participantId}`, { method: 'DELETE' }).catch(() => undefined);
  };

  const getMetrics = (): VenueMetricsSnapshot => {
    const peerMetrics = [...peerHistory].map(([key, metrics]) => {
      const link = links.get(key);
      const [micSlot, speakerSlot] = key.split(':').map(Number);
      return Object.freeze({
        peerId: key,
        side: side === 'mic' ? 'speaker' : 'mic',
        slot: side === 'mic' ? link?.speakerSlot ?? speakerSlot! : link?.micSlot ?? micSlot!,
        micSlot: link?.micSlot ?? micSlot!,
        speakerSlot: link?.speakerSlot ?? speakerSlot!,
        active: Boolean(link),
        state: link?.peer.connectionState ?? 'closed' as RTCPeerConnectionState,
        iceState: link?.peer.iceConnectionState ?? 'closed' as RTCIceConnectionState,
        iceGatheringState: link?.peer.iceGatheringState ?? 'complete' as RTCIceGatheringState,
        signalingState: link?.peer.signalingState ?? 'closed' as RTCSignalingState,
        connected: link?.peer.connectionState === 'connected',
        sentPackets: metrics.sentPackets,
        sentBytes: metrics.sentPcmBytes,
        backpressureDrops: metrics.bufferedAmountDrops,
        receivedPackets: metrics.receivedPackets,
        receivedBytes: metrics.receivedPcmBytes,
        sequenceGaps: metrics.sequenceGaps,
        duplicates: metrics.duplicates,
        invalidPackets: metrics.invalidPackets,
        rttMs: link ? metrics.rttMs : null,
      });
    });
    const total = (field: 'backpressureDrops' | 'receivedPackets' | 'receivedBytes' | 'sequenceGaps' | 'duplicates' | 'invalidPackets') => peerMetrics.reduce((sum, peer) => sum + peer[field], 0);
    const rtts = peerMetrics.flatMap((peer) => peer.rttMs === null ? [] : [peer.rttMs]);
    const workletStreams = (audio.getWorkletStreams?.() ?? []).map((stream) => Object.freeze({ ...stream }));
    return Object.freeze({
      role: side,
      slot: registration.slot,
      transport,
      activePeers: links.size,
      connectedPeers: peerMetrics.filter((peer) => peer.connected).length,
      sentPackets,
      sentBytes: sentPcmBytes,
      backpressureDrops: total('backpressureDrops'),
      receivedPackets: total('receivedPackets'),
      receivedBytes: total('receivedBytes'),
      sequenceGaps: total('sequenceGaps'),
      duplicates: total('duplicates'),
      invalidPackets: total('invalidPackets'),
      rttMs: rtts.length ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : null,
      peers: Object.freeze(peerMetrics),
      workletStreams: Object.freeze(workletStreams),
    });
  };

  return { connected, getRtt: () => latestRtt, getMetrics, close };
}

export type VenueSession = { close: () => void; connected: Promise<void>; getRtt: () => number | null; getMetrics: () => VenueSessionMetrics };
export type VenueMicOptions = TransportOptions;
export type VenueSpeakerOptions = TransportOptions;

export type PreparedVenueSpeakerAudio = { context: AudioContext; ready: Promise<void> };
export type PreparedVenueMicAudio = {
  context: AudioContext;
  ready: Promise<void>;
  source?: MediaStreamAudioSourceNode;
  ownsContext?: boolean;
};

/** Call synchronously from the speaker's user-gesture handler to unlock iOS Web Audio. */
export function prepareVenueSpeakerAudio(): PreparedVenueSpeakerAudio {
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  return { context, ready: context.resume() };
}

/** Call synchronously from the mic toggle's user gesture so iOS starts the PCM worklet before API waits. */
export function prepareVenueMicAudio(): PreparedVenueMicAudio {
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  const ready = context.resume();
  ready.catch(() => undefined);
  return { context, ready };
}

export async function startVenueMic(stream: MediaStream, options: VenueMicOptions = {}, preparedAudio?: PreparedVenueMicAudio): Promise<VenueSession> {
  const roomId = options.roomId ?? ROOM_ID;
  const transport = options.transport ?? 'pcm';
  const ownsContext = preparedAudio?.ownsContext ?? true;
  let registration: Registration | undefined;
  let context: AudioContext | undefined = preparedAudio?.context;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let silent: GainNode | undefined;
  let sendPcm: (data: ArrayBuffer) => void = () => undefined;
  let sequence = 0;
  const closeAudio = () => {
    if (source && processor) source.disconnect(processor);
    processor?.disconnect();
    silent?.disconnect();
    if (ownsContext) void context?.close();
  };
  try {
    if (preparedAudio) await preparedAudio.ready;
    const registered = await registerParticipant('mic', options);
    registration = registered;
    if (transport === 'audio-track') {
      if (ownsContext) await context?.close();
      return createSession('mic', registered, roomId, () => undefined, () => ({ close: () => undefined }), transport, stream, options.onLeaseLost);
    }
    context ??= new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    if (context.state !== 'running') await context.resume();
    await context.audioWorklet.addModule(venuePcmWorkletUrl);
    processor = new AudioWorkletNode(context, 'venue-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const micSource = preparedAudio?.source ?? context.createMediaStreamSource(stream);
    micSource.connect(processor);
    source = micSource;
    silent = context.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(context.destination);
    processor.port.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) sendPcm(encodePcmPacket(registered.slot, sequence++, performance.now(), data));
    };
  } catch (error) {
    closeAudio();
    if (registration) void apiFetch(`${roomPath(roomId)}/participants/${registration.participantId}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
  if (!registration) throw new Error('マイク登録に失敗しました');
  const session = createSession('mic', registration, roomId, () => undefined, () => ({ close: () => {
    closeAudio();
  }, setPcmSender: (send) => { sendPcm = send; } }), transport, stream, options.onLeaseLost);
  return session;
}

export async function startVenueSpeaker(onRtt: (rtt: number) => void, options: VenueSpeakerOptions = {}, preparedAudio?: PreparedVenueSpeakerAudio): Promise<VenueSession> {
  const roomId = options.roomId ?? ROOM_ID;
  const transport = options.transport ?? 'pcm';
  const audio = preparedAudio ?? prepareVenueSpeakerAudio();
  const context = audio.context;
  let processor: AudioWorkletNode | undefined;
  let registration: Registration | undefined;
  const workletStreams = new Map<string, VenueWorkletStreamMetrics>();
  try {
    await audio.ready;
    if (context.state !== 'running') await context.resume();
    registration = await registerParticipant('speaker', options);
    if (transport === 'pcm') {
      await context.audioWorklet.addModule(venuePcmWorkletUrl);
      processor = new AudioWorkletNode(context, 'venue-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      processor.connect(context.destination);
      processor.port.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'stats' || !('streams' in data) || !Array.isArray(data.streams)) return;
      workletStreams.clear();
      for (const stream of data.streams) {
        if (!stream || typeof stream !== 'object' || !('micId' in stream) || typeof stream.micId !== 'string') continue;
        const values = stream as { queuedMs?: unknown; underflows?: unknown; overflows?: unknown; dropped?: unknown; peak?: unknown };
        const metric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
        workletStreams.set(stream.micId, Object.freeze({
          micId: stream.micId,
          queuedMs: metric(values.queuedMs),
          underflows: metric(values.underflows),
          overflows: metric(values.overflows),
          dropped: metric(values.dropped),
          peak: metric(values.peak),
        }));
      }
      };
    }
  } catch (error) {
    processor?.disconnect();
    void context.close();
    if (registration) void apiFetch(`${roomPath(roomId)}/participants/${registration.participantId}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
  if (!registration) throw new Error('スピーカー登録に失敗しました');
  const session = createSession('speaker', registration, roomId, onRtt, () => ({
    close: () => { processor?.disconnect(); if (context) void context.close(); },
    onPcm: (micId, sequence, timestamp, data) => processor?.port.postMessage({ type: 'enqueue', micId, sequence, timestamp, payload: data }, [data]),
    getWorkletStreams: () => [...workletStreams.values()],
    ...(transport === 'audio-track' ? { onTrack: (track: MediaStreamTrack, streams: readonly MediaStream[]) => {
      const mediaStream = streams[0] ?? new MediaStream([track]);
      const source = context!.createMediaStreamSource(mediaStream);
      const gain = context!.createGain();
      gain.gain.value = 1 / 3;
      source.connect(gain);
      gain.connect(context!.destination);
      let stopped = false;
      const stop = () => {
        if (!stopped) {
          stopped = true;
          source.disconnect();
          gain.disconnect();
        }
      };
      track.addEventListener('ended', stop, { once: true });
      return () => { track.removeEventListener('ended', stop); stop(); };
    } } : {}),
  }), transport, undefined, options.onLeaseLost);
  return session;
}

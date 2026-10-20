import { apiFetch } from '@/lib/api';
import venuePcmWorkletUrl from './venue-pcm.worklet.js?url&no-inline';

type Signal = { type: 'offer' | 'answer'; sdp: string };
type Side = 'mic' | 'speaker';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export type VenueSession = {
  close: () => void;
  connected: Promise<void>;
  getRtt: () => number | null;
};
const signalUrl = (side: Side) => `/venue-speaker/${side}`;
async function putSignal(side: Side, signal: Signal) {
  await apiFetch(signalUrl(side), { method: 'PUT', body: signal });
}
async function getSignal(side: Side): Promise<Signal | null> {
  return apiFetch(signalUrl(side), {
    schema: { parse: (v) => v as Signal | null },
  });
}
async function waitForSignal(side: Side, peer: RTCPeerConnection) {
  for (let i = 0; i < 120; i++) {
    if (peer.signalingState === 'closed') throw new Error('接続が終了しました');
    const signal = await getSignal(side);
    if (signal) return signal;
    await sleep(500);
  }
  throw new Error('相手が見つかりません。両端末を同じWi-Fiに接続してください');
}
function waitIce(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    peer.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 8000);
  });
}
export async function startVenueMic(
  stream: MediaStream,
): Promise<VenueSession> {
  await apiFetch('/venue-speaker/mic', { method: 'DELETE' }).catch(
    () => undefined,
  );
  const peer = new RTCPeerConnection({ iceServers: [] });
  const channel = peer.createDataChannel('pcm', {
    ordered: false,
    maxRetransmits: 0,
  });
  const context = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 48000,
  });
  await context.audioWorklet.addModule(venuePcmWorkletUrl);
  const processor = new AudioWorkletNode(context, 'venue-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const source = context.createMediaStreamSource(stream);
  source.connect(processor);
  // Keep the worklet clock running without monitoring the microphone locally.
  const silent = context.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(context.destination);
  processor.port.onmessage = ({ data }) => {
    if (channel.readyState === 'open' && channel.bufferedAmount < 64_000)
      channel.send(data as ArrayBuffer);
  };
  let rtt: number | null = null;
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as { kind: string; at?: number };
      if (message.kind === 'ping')
        channel.send(JSON.stringify({ kind: 'pong', at: message.at }));
    }
  };
  const ping = setInterval(() => {
    if (channel.readyState === 'open') {
      const at = performance.now();
      channel.send(JSON.stringify({ kind: 'ping', at }));
    }
  }, 1000);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitIce(peer);
  await putSignal('mic', { type: 'offer', sdp: peer.localDescription!.sdp! });
  void waitForSignal('mic', peer)
    .then((answer) => peer.setRemoteDescription(answer))
    .catch(() => undefined);
  const connected = new Promise<void>((resolve, reject) => {
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') resolve();
      if (peer.connectionState === 'failed')
        reject(
          new Error(
            'WebRTC 接続に失敗しました。Wi-Fi の端末間通信を確認してください',
          ),
        );
    };
  });
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as { kind: string; at?: number };
      if (message.kind === 'ping' && message.at !== undefined)
        channel.send(JSON.stringify({ kind: 'pong', at: message.at }));
      if (message.kind === 'pong' && message.at !== undefined)
        rtt = performance.now() - message.at;
    }
  };
  return {
    connected,
    getRtt: () => rtt,
    close: () => {
      clearInterval(ping);
      source.disconnect();
      processor.disconnect();
      silent.disconnect();
      void context.close();
      peer.close();
      void apiFetch(signalUrl('mic'), { method: 'DELETE' }).catch(
        () => undefined,
      );
    },
  };
}

export async function startVenueSpeaker(
  onRtt: (rtt: number) => void,
): Promise<VenueSession> {
  await apiFetch('/venue-speaker/speaker', { method: 'DELETE' }).catch(
    () => undefined,
  );
  const peer = new RTCPeerConnection({ iceServers: [] });
  const context = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 48000,
  });
  await context.audioWorklet.addModule(venuePcmWorkletUrl);
  const processor = new AudioWorkletNode(context, 'venue-pcm', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  processor.connect(context.destination);
  let rtt: number | null = null;
  const connected = new Promise<void>((resolve, reject) => {
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') resolve();
      if (peer.connectionState === 'failed')
        reject(
          new Error(
            'WebRTC 接続に失敗しました。Wi-Fi の端末間通信を確認してください',
          ),
        );
    };
  });
  let ping: ReturnType<typeof setInterval> | undefined;
  peer.ondatachannel = ({ channel }) => {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        processor.port.postMessage(data, [data]);
        return;
      }
      const message = JSON.parse(data) as { kind: string; at?: number };
      if (message.kind === 'ping' && message.at !== undefined)
        channel.send(JSON.stringify({ kind: 'pong', at: message.at }));
      if (message.kind === 'pong' && message.at !== undefined) {
        rtt = performance.now() - message.at;
        onRtt(rtt);
      }
    };
    ping = setInterval(() => {
      if (channel.readyState === 'open') {
        const at = performance.now();
        channel.send(JSON.stringify({ kind: 'ping', at }));
      }
    }, 1000);
  };
  const offer = await waitForSignal('speaker', peer);
  await peer.setRemoteDescription(offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitIce(peer);
  await putSignal('speaker', {
    type: 'answer',
    sdp: peer.localDescription!.sdp!,
  });
  return {
    connected,
    getRtt: () => rtt,
    close: () => {
      if (ping) clearInterval(ping);
      processor.disconnect();
      void context.close();
      peer.close();
      void apiFetch(signalUrl('speaker'), { method: 'DELETE' }).catch(
        () => undefined,
      );
    },
  };
}

/**
 * WebAudio の音声ミキサー。各チャンネル → GainNode → マスター → MediaStreamDestination（配信用の音声トラック）。
 * レベルメーターはチャンネルはフェーダー前（入力の有無を確認するため）、マスターはフェーダー後。
 */
import { readAnalyserLevel } from '@/features/sender/audioLevel';
import type { ChannelId } from '../engine/mixer';

type Channel = { track: MediaStreamTrack; source: MediaStreamAudioSourceNode; gain: GainNode; analyser: AnalyserNode; sink: HTMLAudioElement };

// フェーダー操作でノイズが出ないように少しだけ追従させる
const GAIN_SMOOTHING_SEC = 0.02;

export function createAudioGraph() {
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  const master = context.createGain();
  const masterAnalyser = context.createAnalyser();
  const destination = context.createMediaStreamDestination();
  master.connect(masterAnalyser).connect(destination);
  const channels = new Map<ChannelId, Channel>();
  const gains = new Map<ChannelId, number>();
  const buffer = new Float32Array(1024);
  masterAnalyser.fftSize = buffer.length;

  const remove = (id: ChannelId) => {
    const channel = channels.get(id);
    if (!channel) return;
    channel.source.disconnect();
    channel.gain.disconnect();
    channel.sink.srcObject = null;
    channels.delete(id);
  };

  return {
    track: destination.stream.getAudioTracks()[0] ?? null,
    resume: () => context.resume(),
    setChannelTrack(id: ChannelId, track: MediaStreamTrack | null) {
      if (channels.get(id)?.track === track) return;
      remove(id);
      if (!track) return;
      const stream = new MediaStream([track]);
      // Chrome では受信音声を media 要素にも繋がないと WebAudio に流れない
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      void sink.play().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = buffer.length;
      const gain = context.createGain();
      gain.gain.value = gains.get(id) ?? 0;
      source.connect(analyser);
      source.connect(gain).connect(master);
      channels.set(id, { track, source, gain, analyser, sink });
    },
    setGain(id: ChannelId, value: number) {
      gains.set(id, value);
      channels.get(id)?.gain.gain.setTargetAtTime(value, context.currentTime, GAIN_SMOOTHING_SEC);
    },
    setMasterGain(value: number) {
      master.gain.setTargetAtTime(value, context.currentTime, GAIN_SMOOTHING_SEC);
    },
    levels(): { channels: Map<ChannelId, number>; master: number } {
      const result = new Map<ChannelId, number>();
      for (const [id, channel] of channels) result.set(id, readAnalyserLevel(channel.analyser, buffer));
      return { channels: result, master: readAnalyserLevel(masterAnalyser, buffer) };
    },
    close() {
      [...channels.keys()].forEach(remove);
      void context.close();
    },
  };
}
export type AudioGraph = ReturnType<typeof createAudioGraph>;

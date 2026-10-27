import { readAnalyserLevel } from './audioLevel';

/** One capture graph is shared by IVS and the venue PCM sender. */
export type PreparedMicAudio = { context: AudioContext; ready: Promise<void> };

export type MicAudioGraph = {
  context: AudioContext;
  ready: Promise<void>;
  source: MediaStreamAudioSourceNode;
  streamTrack: MediaStreamTrack;
  dspMode: 'processed' | 'bypass';
  level: () => number;
  bypassDsp: () => void;
  close: () => void;
};

/** Call in a click handler, before awaiting getUserMedia, to unlock iOS Web Audio. */
export function prepareMicAudio(existing?: PreparedMicAudio): PreparedMicAudio {
  const context = existing?.context ?? new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  const ready = context.resume();
  ready.catch(() => undefined);
  return { context, ready };
}

export async function createMicAudioGraph(rawTrack: MediaStreamTrack, prepared: PreparedMicAudio): Promise<MicAudioGraph> {
  const { context } = prepared;
  await prepared.ready;
  if (context.state !== 'running') await context.resume();

  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  destination.channelCountMode = 'explicit';
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const levelBuffer = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  let highPass: BiquadFilterNode | undefined;
  let compressor: DynamicsCompressorNode | undefined;
  let dspMode: MicAudioGraph['dspMode'] = 'processed';
  try {
    highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 80;
    compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 12;
    compressor.ratio.value = 2;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    source.connect(highPass);
    highPass.connect(compressor);
    compressor.connect(destination);
  } catch (error) {
    highPass?.disconnect();
    compressor?.disconnect();
    source.connect(destination);
    dspMode = 'bypass';
    // The stream must still be published; callers can report the degraded mode.
    void error;
  }

  const streamTrack = destination.stream.getAudioTracks()[0];
  if (!streamTrack) {
    source.disconnect();
    analyser.disconnect();
    highPass?.disconnect();
    compressor?.disconnect();
    destination.disconnect();
    throw new Error('配信用の音声トラックを作成できません');
  }

  let closed = false;
  const graph: MicAudioGraph = {
    context,
    ready: prepared.ready,
    source,
    streamTrack,
    dspMode,
    level: () => readAnalyserLevel(analyser, levelBuffer),
    bypassDsp: () => {
      if (closed || graph.dspMode === 'bypass') return;
      source.disconnect(highPass!);
      highPass?.disconnect();
      compressor?.disconnect();
      source.connect(destination);
      graph.dspMode = 'bypass';
    },
    close: () => {
      if (closed) return;
      closed = true;
      source.disconnect();
      analyser.disconnect();
      highPass?.disconnect();
      compressor?.disconnect();
      destination.disconnect();
      streamTrack.stop();
      void context.close();
    },
  };
  return graph;
}

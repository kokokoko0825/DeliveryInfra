const VENUE_RATE = 48000;
const PACKET_SAMPLES = 480;
const MAX_STREAMS = 3;

class VenuePcm extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const configured = options.processorOptions?.jitterMs ?? 10;
    this.jitterMs = Math.max(5, Math.min(15, Number(configured) || 10));
    this.targetSamples = Math.round(VENUE_RATE * this.jitterMs / 1000);
    this.maxPackets = Math.ceil(this.jitterMs / 10) + 1;
    this.streams = new Map();
    this.pending = new Float32Array(PACKET_SAMPLES);
    this.pendingLength = 0;
    this.sequence = 0;
    this.lastStatsAt = 0;
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  makeStream() {
    return {
      packets: [], samples: 0, offset: 0, started: false,
      highestSequence: -1, seen: new Set(), lastPlayedSequence: -1, lastPlayedTimestamp: -1,
      stats: { gaps: 0, reordered: 0, dropped: 0, underflows: 0, overflows: 0, peak: 0 },
    };
  }

  onMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'stats-request') {
      this.postStats();
      return;
    }
    // Backwards-compatible single stream input; packet metadata is generated locally.
    if (data instanceof ArrayBuffer) {
      this.enqueue('default', this.sequence++, currentTime * 1000, data);
      return;
    }
    if (data.type === 'enqueue') this.enqueue(data.micId, data.sequence, data.timestamp, data.payload);
  }

  enqueue(micId, sequence, timestamp, payload) {
    if (typeof micId !== 'string' || !micId || !Number.isSafeInteger(sequence) || sequence < 0 ||
        !Number.isFinite(timestamp) || timestamp < 0) return;
    const bytes = payload instanceof ArrayBuffer ? payload : ArrayBuffer.isView(payload) ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : null;
    if (!bytes || bytes.byteLength !== PACKET_SAMPLES * 2) return;
    let stream = this.streams.get(micId);
    if (!stream) {
      if (this.streams.size >= MAX_STREAMS) return;
      stream = this.makeStream();
      this.streams.set(micId, stream);
    }
    const stats = stream.stats;
    if (stream.seen.has(sequence) || sequence <= stream.lastPlayedSequence) {
      stats.dropped++;
      return;
    }
    if (timestamp <= stream.lastPlayedTimestamp) {
      stats.dropped++;
      return;
    }
    const nextIndex = stream.packets.findIndex((packet) => packet.sequence > sequence);
    const previous = stream.packets[nextIndex < 0 ? stream.packets.length - 1 : nextIndex - 1];
    const next = nextIndex < 0 ? undefined : stream.packets[nextIndex];
    if ((previous && timestamp <= previous.timestamp) || (next && timestamp >= next.timestamp)) {
      stats.dropped++;
      return;
    }
    stream.seen.add(sequence);
    if (sequence < stream.highestSequence) stats.reordered++;
    if (stream.highestSequence >= 0 && sequence > stream.highestSequence + 1) stats.gaps += sequence - stream.highestSequence - 1;
    stream.highestSequence = Math.max(stream.highestSequence, sequence);
    const packet = { sequence, timestamp, data: new Int16Array(bytes) };
    let index = nextIndex;
    if (index < 0) index = stream.packets.length;
    stream.packets.splice(index, 0, packet);
    stream.samples += PACKET_SAMPLES;
    if (stream.packets.length > this.maxPackets) {
      const removed = stream.packets.shift();
      stream.samples -= PACKET_SAMPLES - stream.offset;
      stats.overflows++;
      stats.dropped++;
      if (stream.offset) stream.offset = 0;
      stream.seen.delete(removed.sequence);
      void removed;
    }
  }

  takeSample(stream) {
    if (!stream.started) {
      if (stream.samples < this.targetSamples) return null;
      stream.started = true;
    }
    const packet = stream.packets[0];
    if (!packet) return null;
    const value = packet.data[stream.offset] / 32768;
    stream.offset++;
    stream.samples--;
    if (stream.offset === PACKET_SAMPLES) {
      stream.lastPlayedSequence = packet.sequence;
      stream.lastPlayedTimestamp = packet.timestamp;
      stream.seen.delete(packet.sequence);
      stream.packets.shift();
      stream.offset = 0;
    }
    return value;
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) {
      for (let i = 0; i < output.length; i++) {
        let mixed = 0;
        for (const stream of this.streams.values()) {
          const sample = this.takeSample(stream);
          if (sample === null) {
            if (stream.started) stream.stats.underflows++;
            continue;
          }
          mixed += sample;
          stream.stats.peak = Math.max(stream.stats.peak, Math.abs(sample));
        }
        // Soft knee summing prevents hard clipping when all three mics peak together.
        output[i] = mixed / (1 + Math.abs(mixed));
      }
    }

    const input = inputs[0]?.[0];
    if (input) {
      for (const sample of input) {
        this.pending[this.pendingLength++] = Math.max(-1, Math.min(1, sample));
        if (this.pendingLength === PACKET_SAMPLES) {
          const pcm = new Int16Array(PACKET_SAMPLES);
          for (let i = 0; i < PACKET_SAMPLES; i++) {
            const value = this.pending[i];
            pcm[i] = value < 0 ? value * 32768 : value * 32767;
          }
          this.pendingLength = 0;
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }
      }
    }
    if (currentTime - this.lastStatsAt >= 1) {
      this.lastStatsAt = currentTime;
      this.postStats();
    }
    return true;
  }

  postStats() {
    this.port.postMessage({ type: 'stats', jitterMs: this.jitterMs, streams: [...this.streams].map(([micId, stream]) => ({ micId, queuedPackets: stream.packets.length, queuedMs: stream.samples / 48, ...stream.stats })) });
  }
}

registerProcessor('venue-pcm', VenuePcm);

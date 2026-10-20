class VenuePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.queue = [];
    this.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.queue.push(new Int16Array(event.data));
    };
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) output.fill(0);

    const input = inputs[0]?.[0];
    if (input) {
      for (let index = 0; index < input.length; index++) {
        this.pending.push(Math.max(-1, Math.min(1, input[index])));
      }
      const frameLength = Math.round(sampleRate / 100);
      while (this.pending.length >= frameLength) {
        const part = this.pending.splice(0, frameLength);
        const pcm = new Int16Array(frameLength);
        for (let index = 0; index < frameLength; index++) {
          pcm[index] = part[index] < 0 ? part[index] * 32768 : part[index] * 32767;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }

    if (output) {
      let written = 0;
      while (this.queue.length && written < output.length) {
        const chunk = this.queue[0];
        const count = Math.min(chunk.length, output.length - written);
        for (let index = 0; index < count; index++) output[written + index] = chunk[index] / 32768;
        written += count;
        if (count === chunk.length) this.queue.shift();
        else this.queue[0] = chunk.subarray(count);
      }
    }
    return true;
  }
}

registerProcessor('venue-pcm', VenuePcm);

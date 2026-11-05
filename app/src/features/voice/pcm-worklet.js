// AudioWorklet: downsample microphone audio to mono PCM16 little-endian at 16 kHz and post ~100 ms frames.
// Plain JS on purpose: worklet modules are loaded same-origin as a static file (no inline code, no eval).
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.frameSamples = o.frameSamples || 1600;
    this.ratio = sampleRate / this.target;
    this.pos = 0;
    this.carry = 0;
    this.out = new Int16Array(this.frameSamples);
    this.n = 0;
    this.sumSq = 0;
    this.last = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Box-filter average over `ratio` input samples gives a cheap, alias-resistant downsample.
      this.carry += ch[i];
      this.pos += 1;
      if (this.pos >= this.ratio) {
        let v = this.carry / this.pos;
        this.carry = 0;
        this.pos -= this.ratio;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        this.sumSq += v * v;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frameSamples) {
          const rms = Math.sqrt(this.sumSq / this.n);
          const buf = this.out.buffer;
          this.port.postMessage({ pcm: buf, rms }, [buf]);
          this.out = new Int16Array(this.frameSamples);
          this.n = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16-downsampler', Pcm16Downsampler);

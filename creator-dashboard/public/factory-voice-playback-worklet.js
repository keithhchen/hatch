class HatchVoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.position = 0;
    this.ratio = 24000 / sampleRate;
    this.ending = false;
    this.started = false;
    this.port.onmessage = event => {
      if (event.data?.type === "reset") {
        this.queue = [];
        this.current = null;
        this.position = 0;
        this.ending = false;
        this.started = false;
        return;
      }
      if (event.data?.type === "end") {
        this.ending = true;
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        const source = new Int16Array(event.data);
        const values = new Float32Array(source.length);
        for (let index = 0; index < source.length; index += 1) values[index] = source[index] / 0x8000;
        this.queue.push(values);
      }
    };
  }

  process(_inputs, outputs) {
    const channels = outputs[0] || [];
    const output = channels[0];
    if (!output) return true;
    output.fill(0);
    for (let index = 0; index < output.length; index += 1) {
      while (!this.current || this.position >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.position = 0;
        if (!this.current) break;
      }
      if (!this.current) break;
      const left = Math.floor(this.position);
      const right = Math.min(this.current.length - 1, left + 1);
      const fraction = this.position - left;
      output[index] = this.current[left] * (1 - fraction) + this.current[right] * fraction;
      this.position += this.ratio;
      if (!this.started) {
        this.started = true;
        this.port.postMessage({ type: "playing" });
      }
    }
    for (let channel = 1; channel < channels.length; channel += 1) channels[channel].set(output);
    if (this.ending && !this.current && !this.queue.length) {
      this.ending = false;
      this.started = false;
      this.port.postMessage({ type: "ended" });
    }
    return true;
  }
}

registerProcessor("hatch-voice-playback", HatchVoicePlaybackProcessor);

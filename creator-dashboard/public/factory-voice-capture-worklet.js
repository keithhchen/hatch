class HatchVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourcePosition = 0;
    this.ratio = sampleRate / 16000;
    this.samples = new Int16Array(320);
    this.sampleCount = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input?.length) return true;
    while (this.sourcePosition < input.length) {
      const index = Math.min(input.length - 1, Math.floor(this.sourcePosition));
      const value = Math.max(-1, Math.min(1, input[index] || 0));
      this.samples[this.sampleCount++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      this.sourcePosition += this.ratio;
      if (this.sampleCount === this.samples.length) {
        const chunk = this.samples.buffer;
        this.port.postMessage(chunk, [chunk]);
        this.samples = new Int16Array(320);
        this.sampleCount = 0;
      }
    }
    this.sourcePosition -= input.length;
    return true;
  }
}

registerProcessor("hatch-voice-capture", HatchVoiceCaptureProcessor);

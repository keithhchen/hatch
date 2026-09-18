/** Plays TTS segments in order and reports the segment that is actually audible. */
export class FactoryVoicePlayer {
  constructor(onSpeechChange, onError) {
    this.onSpeechChange = onSpeechChange;
    this.onError = onError;
    this.current = null;
  }

  start(event) {
    this.stop();
    const mimeType = event.mimeType || 'audio/mpeg';
    if (mimeType.startsWith('audio/pcm')) {
      const context = new AudioContext();
      const current = { kind: 'pcm', mimeType, context, node: null, ready: null, speech: null, ended: false };
      current.ready = context.audioWorklet.addModule('/factory-voice-playback-worklet.js').then(async () => {
        if (this.current !== current) return;
        const node = new AudioWorkletNode(context, 'hatch-voice-playback', { outputChannelCount: [1] });
        current.node = node;
        node.connect(context.destination);
        node.port.onmessage = message => {
          if (this.current !== current) return;
          if (message.data?.type === 'playing' && current.speech) this.onSpeechChange(current.speech);
          if (message.data?.type === 'ended') { this.onSpeechChange(null); if (current.ended) this.stop(); }
        };
        await context.resume();
      }).catch(error => this.onError(error));
      this.current = current;
      return;
    }
    this.current = { kind: 'media', mimeType, segments: new Map(), order: [], activeSegmentId: null, ended: false };
  }

  registerSpeech(event) {
    const current = this.current;
    if (current?.kind === 'pcm') { current.speech = { id: event.segmentId, text: event.text || '' }; return; }
    if (!current || current.segments.has(event.segmentId)) return;
    const mediaSource = new MediaSource();
    const audio = new Audio();
    const segment = { id: event.segmentId, text: event.text, audio, mediaSource, sourceBuffer: null, pending: [], ended: false, url: URL.createObjectURL(mediaSource) };
    audio.preload = 'auto';
    audio.src = segment.url;
    current.segments.set(segment.id, segment);
    current.order.push(segment.id);
    if (!current.activeSegmentId || !current.segments.has(current.activeSegmentId)) current.activeSegmentId = segment.id;
    audio.addEventListener('playing', () => this.playing(segment.id));
    audio.addEventListener('ended', () => this.finished(segment.id));
    mediaSource.addEventListener('sourceopen', () => {
      const live = this.current?.segments.get(segment.id);
      if (!live || live.mediaSource.readyState !== 'open') return;
      if (!MediaSource.isTypeSupported(this.current.mimeType)) return this.onError(new Error(`Browser cannot play ${this.current.mimeType}`));
      live.sourceBuffer = live.mediaSource.addSourceBuffer(this.current.mimeType);
      live.sourceBuffer.addEventListener('updateend', () => this.flush(segment.id));
      this.flush(segment.id);
      this.playIfActive(segment.id);
    }, { once: true });
  }

  endSpeech(event) { const current = this.current; if (current?.kind === 'pcm') return; const segment = current?.segments.get(event.segmentId); if (segment) { segment.ended = true; this.flush(segment.id); } }
  chunk(event) {
    const current = this.current;
    if (current?.kind === 'pcm') {
      const bytes = Uint8Array.from(atob(event.audio), character => character.charCodeAt(0));
      void current.ready.then(() => {
        if (this.current !== current || !current.node) return;
        current.node.port.postMessage(bytes.buffer, [bytes.buffer]);
      });
      return;
    }
    const segment = current?.segments.get(event.segmentId);
    if (!segment) return;
    segment.pending.push(Uint8Array.from(atob(event.audio), character => character.charCodeAt(0)).buffer);
    this.flush(segment.id);
    this.playIfActive(segment.id);
  }
  end() { if (!this.current) return; this.current.ended = true; if (this.current.kind === 'pcm') { void this.current.ready.then(() => this.current?.node?.port.postMessage({ type: 'end' })); return; } for (const segment of this.current.segments.values()) { segment.ended = true; this.flush(segment.id); } }

  stop() {
    const current = this.current;
    this.current = null;
    this.onSpeechChange(null);
    if (!current) return;
    if (current.kind === 'pcm') {
      current.node?.port.postMessage({ type: 'reset' });
      current.node?.disconnect();
      void current.context.close();
      return;
    }
    for (const segment of current.segments.values()) this.release(segment);
  }

  playIfActive(id) {
    const current = this.current; const segment = current?.segments.get(id);
    if (!current || !segment?.sourceBuffer || current.activeSegmentId !== id) return;
    void segment.audio.play().catch(error => this.onError(error));
  }
  playing(id) { const segment = this.current?.segments.get(id); if (segment) this.onSpeechChange({ id, text: segment.text }); }
  finished(id) {
    const current = this.current;
    if (!current || current.activeSegmentId !== id) return;
    const index = current.order.indexOf(id); const next = current.order[index + 1]; const segment = current.segments.get(id);
    if (segment) { this.release(segment); current.segments.delete(id); }
    if (next) { current.activeSegmentId = next; this.playIfActive(next); }
    else if (current.ended) { this.onSpeechChange(null); this.current = null; }
    else current.activeSegmentId = null;
  }
  flush(id) {
    const segment = this.current?.segments.get(id);
    if (!segment?.sourceBuffer || segment.sourceBuffer.updating) return;
    const chunk = segment.pending.shift();
    if (chunk) { try { segment.sourceBuffer.appendBuffer(chunk); } catch (error) { this.onError(error); } }
    else if (segment.ended && segment.mediaSource.readyState === 'open') segment.mediaSource.endOfStream();
  }
  release(segment) { segment.audio.pause(); segment.audio.removeAttribute('src'); segment.audio.load(); URL.revokeObjectURL(segment.url); }
}

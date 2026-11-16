/**
 * Microphone capture and transcription, via the local voice service.
 *
 * Whisper wants 16kHz mono PCM16 WAV, so the recording is resampled offline in
 * the browser before upload. Doing that here rather than in Python keeps the
 * payload small and the round trip short.
 */
import { apiUrl } from '../utils/connection.js';

export class SttClient {
  constructor({ endpoint = '/api/stt' } = {}) {
    this.endpoint = endpoint;
    this.recording = false;
  }

  /**
   * Record from the mic until `stop()` is called, then transcribe.
   * @param {(seconds: number) => void} [onLevel] live input level, for UI
   */
  async record(onLevel) {
    if (this.recording) return null;
    this.recording = true;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    await ctx.resume();

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let levelTimer = 0;
    if (onLevel) {
      levelTimer = setInterval(() => {
        analyser.getByteFrequencyData(bins);
        onLevel(bins.reduce((a, b) => a + b, 0) / bins.length / 255);
      }, 100);
    }

    // Record to PCM manually so no MediaRecorder codec is involved.
    const chunks = [];
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(processor);
    // ScriptProcessor needs a destination to be pulled; a muted gain is enough.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);

    // Auto-stop after a silence, so talking and waiting just works.
    const SILENCE_MS = 1400;
    let silence = 0;
    let last = 0;
    const vadTimer = setInterval(() => {
      analyser.getByteFrequencyData(bins);
      const lvl = bins.reduce((a, b) => a + b, 0) / bins.length / 255;
      if (lvl < 0.02) silence += 100;
      else silence = 0;
      if (silence >= SILENCE_MS) last = Date.now();
    }, 100);

    const started = Date.now();
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (!this.recording) { clearInterval(poll); return resolve(); }
        if (Date.now() - started > 15000) { clearInterval(poll); return resolve(); }
        if (last && Date.now() - last > 200) { clearInterval(poll); return resolve(); }
      }, 100);
    });

    clearInterval(vadTimer);
    clearInterval(levelTimer);
    this.recording = false;
    processor.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());

    const total = chunks.reduce((a, c) => a + c.length, 0);
    if (total < 1600) {
      await ctx.close();
      return { text: '' };
    }

    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }

    const wav = encodeWav16k(pcm, ctx.sampleRate);
    await ctx.close();

    const r = await fetch(apiUrl(this.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    if (!r.ok) throw new Error(`stt http ${r.status}`);
    const j = await r.json();
    return { text: (j.text || '').trim() };
  }

  stop() {
    this.recording = false;
  }
}

/** Resample float samples to 16kHz mono PCM16 and wrap in a WAV header. */
function encodeWav16k(input, srcRate) {
  const target = 16000;
  const resampled = resample(input, srcRate, target);
  const bytes = resampled.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);

  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 1, true);   // mono
  dv.setUint32(24, target, true);
  dv.setUint32(28, target * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, bytes, true);

  let o = 44;
  for (let i = 0; i < resampled.length; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buf;
}

function resample(input, srcRate, dstRate) {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

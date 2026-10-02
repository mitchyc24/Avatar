// Shared Web Audio helpers.

let ctx = null;

export function ensureAudioContext() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) ctx = new Ctx();
  }
  ctx?.resume?.().catch(() => {});
  return ctx;
}

// Returns a function giving the current loudness (0..1) of a stream.
export function levelMeter(stream) {
  const audio = ensureAudioContext();
  if (!audio) return Object.assign(() => 0, { disconnect() {} });
  const source = audio.createMediaStreamSource(stream);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let level = 0;
  const read = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    level = Math.max(rms, level * 0.85); // fast attack, gentle release
    return level;
  };
  read.disconnect = () => { try { source.disconnect(); } catch { /* already gone */ } };
  return read;
}

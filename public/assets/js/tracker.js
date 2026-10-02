// Webcam face tracking with MediaPipe Face Landmarker, reduced to avatar pose
// parameters (see protocol.js). Runs entirely in the browser; frames never leave it.
import { FaceLandmarker, FilesetResolver } from '../../vendor/mediapipe/vision_bundle.mjs';
import { neutralPose } from './protocol.js';

// Absolute URL, so the app also works when hosted under a sub-path (GitHub Pages).
const VENDOR = new URL('../../vendor/mediapipe', import.meta.url).href;

// Landmark indices (MediaPipe 478-point face mesh). Which eye ends up on the
// image-left side is decided per frame from the x coordinates, not assumed.
const EYE_1 = { outer: 33, inner: 133, lids: [[160, 144], [158, 153]] };
const EYE_2 = { outer: 263, inner: 362, lids: [[385, 380], [387, 373]] };
const IRISES = [468, 473];
const NOSE_TIP = 1, CHIN = 152, FOREHEAD = 10, CHEEK_1 = 234, CHEEK_2 = 454;

const CALIBRATION_FRAMES = 15;
const BLENDSHAPE_KEYS = ['smile', 'frown', 'browUp', 'browDown', 'browOuterUp', 'squint', 'wide', 'funnel', 'pucker', 'jaw', 'cheekPuff'];

const clamp = (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

// One Euro filter: smooths jitter when still, stays responsive when moving.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.25, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(value, tMs) {
    if (this.x == null) { this.x = value; this.t = tMs; return value; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

function defaultBaseline() {
  return { yaw: 0, pitch: 0.42, x: 0, y: 0, scale: 0.3, gaze: 0, earL: 0.28, earR: 0.28, bs: {} };
}

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.running = false;
    this.base = defaultBaseline();
    this.samples = [];
    this.calibrating = true;
    this.filters = {};
    this.lastTs = 0;
    this.intervalMs = 40; // ~25 fps, relaxed on slow devices
    this.avgCostMs = 0;
    this.delegate = null;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(`${VENDOR}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${VENDOR}/face_landmarker.task`, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU face tracking unavailable, using CPU', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
  }

  recenter() {
    this.samples = [];
    this.calibrating = true;
  }

  start(video, onPose) {
    this.running = true;
    this.video = video;
    let last = 0;
    const schedule = () => {
      if (!this.running) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      if (video.readyState >= 2 && video.videoWidth && now - last >= this.intervalMs) {
        last = now;
        const ts = Math.max(now, this.lastTs + 1); // MediaPipe needs strictly increasing timestamps
        this.lastTs = ts;
        let result = null;
        try {
          result = this.landmarker.detectForVideo(video, ts);
        } catch (err) {
          console.warn('face tracking frame failed', err);
        }
        const cost = performance.now() - now;
        this.avgCostMs = this.avgCostMs * 0.9 + cost * 0.1;
        this.intervalMs = this.avgCostMs > 45 ? 90 : this.avgCostMs > 25 ? 60 : 40;
        onPose(this.process(result, video.videoWidth, video.videoHeight, ts));
      }
      schedule();
    };
    schedule();
  }

  stop() {
    this.running = false;
  }

  process(result, W, H, ts) {
    const lm = result?.faceLandmarks?.[0];
    if (!lm || lm.length < 474) return neutralPose();

    const P = (i) => [lm[i].x * W, lm[i].y * H];

    // Image-left eye first.
    let [eyeL, eyeR] = P(EYE_1.outer)[0] <= P(EYE_2.outer)[0] ? [EYE_1, EYE_2] : [EYE_2, EYE_1];
    const oL = P(eyeL.outer), oR = P(eyeR.outer);
    const roll = Math.atan2(oR[1] - oL[1], oR[0] - oL[0]);

    // Work in a frame centred between the eyes with head roll removed.
    const cx = (oL[0] + oR[0]) / 2, cy = (oL[1] + oR[1]) / 2;
    const cos = Math.cos(-roll), sin = Math.sin(-roll);
    const R = (i) => {
      const [x, y] = P(i); const dx = x - cx, dy = y - cy;
      return [dx * cos - dy * sin, dx * sin + dy * cos];
    };

    const c1 = R(CHEEK_1), c2 = R(CHEEK_2);
    const left = Math.min(c1[0], c2[0]), right = Math.max(c1[0], c2[0]);
    const faceW = Math.max(1, right - left);
    const nose = R(NOSE_TIP);
    const yawRaw = (nose[0] - (left + right) / 2) / (faceW / 2);
    const chin = R(CHIN);
    const pitchRaw = nose[1] / Math.max(1, chin[1]);

    const ear = (eye) => {
      const w = dist(R(eye.outer), R(eye.inner));
      const v = eye.lids.reduce((s, [a, b]) => s + dist(R(a), R(b)), 0) / eye.lids.length;
      return v / Math.max(1, w);
    };
    const earL = ear(eyeL), earR = ear(eyeR);

    const irisPos = (eye) => {
      const o = R(eye.outer), n = R(eye.inner);
      const centre = [(o[0] + n[0]) / 2, (o[1] + n[1]) / 2];
      const iris = IRISES.map(R).sort((a, b) => dist(a, centre) - dist(b, centre))[0];
      const lo = Math.min(o[0], n[0]), hi = Math.max(o[0], n[0]);
      return (iris[0] - lo) / Math.max(1, hi - lo) - 0.5;
    };
    const gazeRaw = (irisPos(eyeL) + irisPos(eyeR)) / 2;

    const pts = [CHEEK_1, CHEEK_2, FOREHEAD, CHIN].map(P);
    const fx = pts.reduce((s, p) => s + p[0], 0) / pts.length / W;
    const fy = pts.reduce((s, p) => s + p[1], 0) / pts.length / H;
    const scaleRaw = faceW / W;

    const bs = {};
    for (const c of result.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
    const avg = (a, b) => ((bs[a] ?? 0) + (bs[b] ?? 0)) / 2;
    const shapes = {
      smile: avg('mouthSmileLeft', 'mouthSmileRight'),
      frown: avg('mouthFrownLeft', 'mouthFrownRight'),
      browUp: bs.browInnerUp ?? 0,
      browDown: avg('browDownLeft', 'browDownRight'),
      browOuterUp: avg('browOuterUpLeft', 'browOuterUpRight'),
      squint: avg('eyeSquintLeft', 'eyeSquintRight'),
      wide: avg('eyeWideLeft', 'eyeWideRight'),
      funnel: bs.mouthFunnel ?? 0,
      pucker: bs.mouthPucker ?? 0,
      jaw: bs.jawOpen ?? 0,
      cheekPuff: bs.cheekPuff ?? 0,
    };
    const lookUp = avg('eyeLookUpLeft', 'eyeLookUpRight');
    const lookDown = avg('eyeLookDownLeft', 'eyeLookDownRight');

    if (this.calibrating) {
      this.samples.push({ yawRaw, pitchRaw, fx, fy, scaleRaw, gazeRaw, earL, earR, shapes });
      if (this.samples.length >= CALIBRATION_FRAMES) {
        const s = this.samples;
        const m = (f) => median(s.map(f));
        this.base = {
          yaw: m((x) => x.yawRaw), pitch: m((x) => x.pitchRaw), x: m((x) => x.fx), y: m((x) => x.fy),
          scale: m((x) => x.scaleRaw), gaze: m((x) => x.gazeRaw),
          // Open-eye reference: upper end of what we saw, since blinks pull the median down.
          earL: [...s.map((x) => x.earL)].sort((a, b) => a - b)[Math.floor(s.length * 0.75)],
          earR: [...s.map((x) => x.earR)].sort((a, b) => a - b)[Math.floor(s.length * 0.75)],
          bs: Object.fromEntries(BLENDSHAPE_KEYS.map((k) => [k, Math.min(0.5, m((x) => x.shapes[k]))])),
        };
        this.calibrating = false;
        this.samples = [];
      }
    } else {
      // Track the open-eye reference slowly so lighting changes don't leave eyes half shut.
      for (const [k, v] of [['earL', earL], ['earR', earR]]) {
        this.base[k] = v > this.base[k] ? this.base[k] + (v - this.base[k]) * 0.02 : this.base[k] * 0.9997;
      }
    }

    const b = this.base;
    const relative = (k) => clamp01((shapes[k] - (b.bs[k] ?? 0)) / (1 - (b.bs[k] ?? 0)));
    const blink = (e, base) => 1 - clamp01((e - 0.4 * base) / (0.5 * base));
    const f = (name, v, minCutoff, beta) => {
      this.filters[name] ??= new OneEuro(minCutoff, beta);
      return this.filters[name].filter(v, ts);
    };

    return {
      tracking: true,
      yaw: f('yaw', clamp((yawRaw - b.yaw) * 1.7), 1.0, 0.3),
      pitch: f('pitch', clamp((pitchRaw - b.pitch) * 4), 1.0, 0.3),
      roll: f('roll', clamp(roll / (Math.PI / 4)), 1.0, 0.3),
      x: f('x', clamp((fx - b.x) * 2), 0.8, 0.2),
      y: f('y', clamp((fy - b.y) * 2), 0.8, 0.2),
      scale: f('scale', clamp((scaleRaw / b.scale - 1) * 2), 0.6, 0.2),
      blinkL: f('blinkL', blink(earL, b.earL), 4, 1),
      blinkR: f('blinkR', blink(earR, b.earR), 4, 1),
      gazeX: f('gazeX', clamp((gazeRaw - b.gaze) * 4), 1.0, 0.4),
      gazeY: f('gazeY', clamp((lookUp - lookDown) * 1.5), 1.0, 0.4),
      jaw: f('jaw', relative('jaw'), 3, 1),
      smile: f('smile', relative('smile'), 2, 0.5),
      frown: f('frown', relative('frown'), 2, 0.5),
      funnel: f('funnel', relative('funnel'), 2, 0.5),
      pucker: f('pucker', relative('pucker'), 2, 0.5),
      browUp: f('browUp', relative('browUp'), 2, 0.5),
      browDown: f('browDown', relative('browDown'), 2, 0.5),
      browOuterUp: f('browOuterUp', relative('browOuterUp'), 2, 0.5),
      cheekPuff: f('cheekPuff', relative('cheekPuff'), 2, 0.5),
      squint: f('squint', relative('squint'), 2, 0.5),
      wide: f('wide', relative('wide'), 2, 0.5),
    };
  }
}

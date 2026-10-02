// SVG avatar: a 2.5D cartoon head driven by pose parameters from protocol.js.
// Parts closer to the viewer (nose, eyes, mouth) shift further when the head
// turns, which reads as depth without any 3D rendering.
import { neutralPose } from './protocol.js';

export const PALETTES = {
  skin: ['#f7dcc8', '#efc3a4', '#dca47c', '#bd7f56', '#8e5b3c', '#5f3c27'],
  hair: ['#2b2220', '#4b3427', '#7b4b2a', '#b8793f', '#e3c37c', '#c4473a', '#8c919a', '#f0efe9', '#3d5ab8', '#a54fc0', '#2f8f6f'],
  eyes: ['#4b3427', '#2f6d9e', '#3e7d4a', '#7f6c37', '#555c66'],
  shirt: ['#3f6fd8', '#d9534f', '#2f9e74', '#e2a23b', '#7c5cc4', '#2d3440', '#e9e4da', '#d06aa0'],
  bg: ['#cfe3f7', '#f6dccd', '#d7efdc', '#efe3f8', '#f8efc7', '#d9dde3', '#2c3e57', '#3b2f45'],
};
export const HAIR_STYLES = ['short', 'long', 'bun', 'curly', 'spiky', 'bald'];
export const GLASSES = ['none', 'round', 'square'];
export const FACIAL_HAIR = ['none', 'stubble', 'beard', 'moustache'];
export const NAME_MAX = 32;

const pick = (n) => Math.floor(Math.random() * n);

export function randomStyle() {
  return {
    skin: pick(PALETTES.skin.length), hair: pick(7), eyes: pick(PALETTES.eyes.length),
    shirt: pick(PALETTES.shirt.length), bg: pick(6), hairStyle: pick(HAIR_STYLES.length - 1),
    glasses: Math.random() < 0.3 ? 1 + pick(2) : 0, facialHair: 0, name: '',
  };
}

// Styles arrive from the other peer, so only accept in-range indexes and plain text.
export function sanitizeStyle(raw) {
  const s = randomStyle();
  const idx = (v, n, fallback) => (Number.isInteger(v) && v >= 0 && v < n ? v : fallback);
  if (!raw || typeof raw !== 'object') return s;
  return {
    skin: idx(raw.skin, PALETTES.skin.length, s.skin),
    hair: idx(raw.hair, PALETTES.hair.length, s.hair),
    eyes: idx(raw.eyes, PALETTES.eyes.length, s.eyes),
    shirt: idx(raw.shirt, PALETTES.shirt.length, s.shirt),
    bg: idx(raw.bg, PALETTES.bg.length, s.bg),
    hairStyle: idx(raw.hairStyle, HAIR_STYLES.length, s.hairStyle),
    glasses: idx(raw.glasses, GLASSES.length, 0),
    facialHair: idx(raw.facialHair, FACIAL_HAIR.length, 0),
    name: typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '',
  };
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => {
    const c = (n >> shift) & 0xff;
    return Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

const circles = (list) => list.map(([x, y, r]) =>
  `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`).join('');

function curlyRing(rx, ry, from, to, count, r, cy = 190) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (from + (to - from) * (i / (count - 1))) * Math.PI / 180;
    out.push([+(200 + rx * Math.cos(a)).toFixed(1), +(cy + ry * Math.sin(a)).toFixed(1), r]);
  }
  return circles(out);
}

const SHORT_FRONT = 'M104,178C96,100 144,64 200,64C256,64 304,100 296,178C288,150 276,128 262,118C240,132 200,136 160,126C140,122 118,140 104,178Z';
const HAIR = {
  short: { back: '', front: SHORT_FRONT },
  long: {
    back: 'M98,180C86,92 146,54 200,54C254,54 314,92 302,180L314,322C292,338 262,332 248,306L152,306C138,332 108,338 86,322Z',
    front: 'M104,182C96,100 146,62 200,62C254,62 304,100 296,182C290,140 262,112 218,104C196,128 150,138 112,150C108,160 105,170 104,182Z',
  },
  bun: { back: circles([[200, 50, 34]]), front: SHORT_FRONT },
  curly: {
    back: curlyRing(104, 118, 160, 380, 15, 30),
    front: curlyRing(78, 62, 200, 340, 8, 24, 150),
  },
  spiky: {
    back: '',
    front: 'M104,176C100,120 120,90 130,84L124,50L156,74L166,36L190,66L208,30L224,66L250,40L254,76L284,58L276,92C292,112 300,140 296,176C284,140 262,124 230,120C200,128 160,128 130,122C116,136 108,154 104,176Z',
  },
  bald: { back: '', front: '' },
};

const BEARD = 'M110,206C112,282 154,318 200,318C246,318 288,282 290,206C280,236 266,250 248,252C236,240 222,236 200,238C178,236 164,240 152,252C134,250 120,236 110,206Z';
const MOUSTACHE = 'M168,244C178,232 194,234 200,240C206,234 222,232 232,244C222,250 210,248 200,246C190,248 178,250 168,244Z';

let uid = 0;

export class AvatarView {
  constructor(container, { mirrored = false, label = 'Avatar' } = {}) {
    this.id = `av${++uid}`;
    this.container = container;
    this.mirrored = mirrored;
    this.label = label;
    this.target = neutralPose();
    this.current = neutralPose();
    this.audioLevel = 0;
    this.lastPoseAt = 0;
    this.idleBlink = 0;
    this.nextIdleBlink = performance.now() + 2500;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build();
    this.setStyle(randomStyle());
  }

  build() {
    const id = this.id;
    this.container.innerHTML = `
<svg viewBox="0 0 400 400" class="avatar-svg" role="img" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="${id}-face"><ellipse data-k="faceClip" cx="200" cy="190" rx="92" ry="112"/></clipPath>
    <clipPath id="${id}-eyeL"><ellipse data-k="eyeLClip" cx="0" cy="0" rx="17" ry="12"/></clipPath>
    <clipPath id="${id}-eyeR"><ellipse data-k="eyeRClip" cx="0" cy="0" rx="17" ry="12"/></clipPath>
    <clipPath id="${id}-mouth"><path data-k="mouthClip"/></clipPath>
  </defs>
  <g data-k="body">
    <rect data-k="neck" x="170" y="262" width="60" height="70" rx="24"/>
    <path data-k="shirt" d="M52,400C58,338 118,312 162,308L238,308C282,312 342,338 348,400Z"/>
    <path data-k="collar" d="M170,309Q200,336 230,309" fill="none" stroke-width="5" stroke-linecap="round"/>
  </g>
  <g data-k="head">
    <path data-k="hairBack"/>
    <g data-k="ears">
      <ellipse data-k="earL" cx="110" cy="196" rx="16" ry="24"/>
      <ellipse data-k="earR" cx="290" cy="196" rx="16" ry="24"/>
    </g>
    <ellipse data-k="face" cx="200" cy="190" rx="92" ry="112"/>
    <g clip-path="url(#${id}-face)">
      <g data-k="cheeks">
        <circle data-k="cheekL" cx="146" cy="232" r="16" fill="#ff6f86"/>
        <circle data-k="cheekR" cx="254" cy="232" r="16" fill="#ff6f86"/>
      </g>
      <g data-k="beardG"><path data-k="beard" d="${BEARD}"/></g>
    </g>
    <g data-k="features">
      <g data-k="eyeL" transform="translate(162,182)">
        <ellipse data-k="whiteL" rx="17" ry="12" fill="#fff"/>
        <g clip-path="url(#${id}-eyeL)">
          <g data-k="irisLG"><circle data-k="irisL" r="8.5"/><circle r="4.2" fill="#111"/><circle cx="2.6" cy="-2.6" r="2" fill="#fff"/></g>
        </g>
        <path data-k="lidL" fill="none" stroke-width="3" stroke-linecap="round"/>
      </g>
      <g data-k="eyeR" transform="translate(238,182)">
        <ellipse data-k="whiteR" rx="17" ry="12" fill="#fff"/>
        <g clip-path="url(#${id}-eyeR)">
          <g data-k="irisRG"><circle data-k="irisR" r="8.5"/><circle r="4.2" fill="#111"/><circle cx="2.6" cy="-2.6" r="2" fill="#fff"/></g>
        </g>
        <path data-k="lidR" fill="none" stroke-width="3" stroke-linecap="round"/>
      </g>
      <path data-k="browL" fill="none" stroke-width="7" stroke-linecap="round"/>
      <path data-k="browR" fill="none" stroke-width="7" stroke-linecap="round"/>
      <g data-k="glasses" fill="none" stroke-width="4">
        <g data-k="glassesRound"><circle cx="162" cy="182" r="25"/><circle cx="238" cy="182" r="25"/><path d="M187,180Q200,172 213,180"/></g>
        <g data-k="glassesSquare"><rect x="135" y="162" width="54" height="40" rx="8"/><rect x="211" y="162" width="54" height="40" rx="8"/><path d="M189,178Q200,172 211,178"/></g>
      </g>
    </g>
    <path data-k="nose" fill="none" stroke-width="3.5" stroke-linecap="round" d="M197,202Q189,224 198,228Q204,230 209,226"/>
    <g data-k="mouthG">
      <path data-k="mouth" stroke-width="3.5" stroke-linejoin="round"/>
      <g clip-path="url(#${id}-mouth)">
        <rect data-k="teeth" x="150" width="100" height="12" fill="#fbfbf7"/>
        <ellipse data-k="tongue" cx="200" rx="18" ry="10" fill="#e06a7a"/>
      </g>
      <path data-k="mouthLine" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path data-k="moustache" d="${MOUSTACHE}"/>
    </g>
    <path data-k="hairFront"/>
  </g>
</svg>`;
    this.svg = this.container.querySelector('svg');
    this.el = {};
    for (const node of this.svg.querySelectorAll('[data-k]')) this.el[node.dataset.k] = node;
    this.svg.style.transform = this.mirrored ? 'scaleX(-1)' : '';
  }

  setStyle(style) {
    this.style = sanitizeStyle(style);
    const s = this.style, e = this.el;
    const skin = PALETTES.skin[s.skin], hair = PALETTES.hair[s.hair];
    const line = shade(skin, -0.45);
    const fill = (k, c) => e[k].setAttribute('fill', c);
    fill('face', skin); fill('earL', skin); fill('earR', skin);
    fill('neck', shade(skin, -0.12));
    fill('shirt', PALETTES.shirt[s.shirt]);
    e.collar.setAttribute('stroke', shade(PALETTES.shirt[s.shirt], -0.25));
    for (const k of ['earL', 'earR', 'face']) { e[k].setAttribute('stroke', shade(skin, -0.2)); e[k].setAttribute('stroke-width', '2'); }
    e.nose.setAttribute('stroke', shade(skin, -0.3));
    e.irisL.setAttribute('fill', PALETTES.eyes[s.eyes]);
    e.irisR.setAttribute('fill', PALETTES.eyes[s.eyes]);
    for (const k of ['lidL', 'lidR']) e[k].setAttribute('stroke', line);
    const browColor = s.hairStyle === 5 ? shade(skin, -0.4) : shade(hair, -0.15);
    for (const k of ['browL', 'browR']) e[k].setAttribute('stroke', browColor);
    fill('mouth', '#5b1f2c'); e.mouth.setAttribute('stroke', shade(skin, -0.35));
    e.mouthLine.setAttribute('stroke', shade(skin, -0.45));

    const shape = HAIR[HAIR_STYLES[s.hairStyle]];
    e.hairBack.setAttribute('d', shape.back); fill('hairBack', shade(hair, -0.12));
    e.hairFront.setAttribute('d', shape.front); fill('hairFront', hair);

    e.glasses.setAttribute('stroke', '#22252b');
    e.glassesRound.style.display = s.glasses === 1 ? '' : 'none';
    e.glassesSquare.style.display = s.glasses === 2 ? '' : 'none';

    const facial = FACIAL_HAIR[s.facialHair];
    fill('beard', hair); fill('moustache', hair);
    e.beard.style.display = facial === 'beard' || facial === 'stubble' ? '' : 'none';
    e.beard.setAttribute('fill-opacity', facial === 'stubble' ? '0.28' : '1');
    e.moustache.style.display = facial === 'moustache' || facial === 'beard' ? '' : 'none';

    this.container.style.setProperty('--avatar-bg', PALETTES.bg[s.bg]);
    this.updateLabel();
  }

  setLabel(label) { this.label = label; this.updateLabel(); }
  updateLabel() {
    const who = this.style?.name || this.label;
    this.svg.setAttribute('aria-label', `Animated avatar of ${who}`);
  }

  setPose(pose) {
    this.target = pose;
    this.lastPoseAt = performance.now();
  }

  setAudioLevel(level) { this.audioLevel = level; }

  start() {
    if (this.raf) return;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.step(now, dt);
      this.render(now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = null; }

  // Ease the displayed pose toward the latest target; fall back to an idle
  // animation with voice-driven mouth when there is no fresh tracking data.
  step(now, dt) {
    const fresh = this.target.tracking && now - this.lastPoseAt < 700;
    const goal = fresh ? { ...this.target } : neutralPose();
    if (!fresh) {
      if (!this.reducedMotion) {
        goal.yaw = Math.sin(now / 2300) * 0.08;
        goal.pitch = Math.sin(now / 1700) * 0.04;
        goal.roll = Math.sin(now / 3100) * 0.04;
      }
      if (now > this.nextIdleBlink) {
        this.idleBlink = now;
        this.nextIdleBlink = now + 2500 + Math.random() * 3500;
      }
      const b = now - this.idleBlink < 140 ? 1 : 0;
      goal.blinkL = goal.blinkR = b;
    }
    // Voice drives the mouth when the camera isn't (and nudges it when it is).
    const talk = Math.min(1, this.audioLevel * 4);
    goal.jaw = fresh ? Math.max(goal.jaw, talk * 0.15) : talk * 0.7;

    const rate = (k) => (k.startsWith('blink') ? 40 : k === 'jaw' ? 28 : 16);
    for (const k of Object.keys(goal)) {
      if (k === 'tracking' || k === 'seq') continue;
      const a = 1 - Math.exp(-rate(k) * dt);
      this.current[k] += (goal[k] - this.current[k]) * a;
    }
  }

  render(now) {
    const p = this.current, e = this.el;
    const set = (k, attr, v) => e[k].setAttribute(attr, v);
    const f = (v) => v.toFixed(2);

    const breathe = this.reducedMotion ? 0 : Math.sin(now / 1200) * 1.5;
    const hx = p.x * 40, hy = p.y * 30 + breathe;
    const sc = 1 + p.scale * 0.15;
    const rollDeg = p.roll * 45;
    set('body', 'transform', `translate(${f(hx * 0.45)},${f(breathe * 0.6)})`);
    set('head', 'transform',
      `translate(${f(hx)},${f(hy)}) rotate(${f(rollDeg)} 200 250) translate(200 200) scale(${f(sc)}) translate(-200 -200)`);

    const yaw = p.yaw, pitch = p.pitch;
    const shift = (kx, ky) => `translate(${f(yaw * kx)},${f(pitch * ky)})`;
    set('hairBack', 'transform', shift(-6, -6));
    set('ears', 'transform', shift(-14, -8));
    set('earL', 'rx', f(16 * (1 - Math.max(0, -yaw) * 0.9)));
    set('earR', 'rx', f(16 * (1 - Math.max(0, yaw) * 0.9)));
    const faceRx = 92 * (1 - Math.abs(yaw) * 0.05) + p.cheekPuff * 6;
    set('face', 'rx', f(faceRx)); set('faceClip', 'rx', f(faceRx));
    set('face', 'cx', f(200 + yaw * 4)); set('faceClip', 'cx', f(200 + yaw * 4));
    set('features', 'transform', shift(30, 22));
    set('cheeks', 'transform', shift(22, 16));
    set('beardG', 'transform', shift(18, 14));
    set('nose', 'transform', shift(40, 26));
    set('mouthG', 'transform', shift(30, 20));
    set('hairFront', 'transform', shift(12, 8));

    // Eyes. The far eye narrows a little as the head turns.
    const open = 1 + p.wide * 0.35 - p.squint * 0.35 - p.smile * 0.12;
    for (const side of ['L', 'R']) {
      const blink = side === 'L' ? p.blinkL : p.blinkR;
      const far = side === 'L' ? Math.max(0, -yaw) : Math.max(0, yaw);
      const rx = 17 * (1 - far * 0.3);
      const ry = Math.max(0.01, 12 * open * (1 - blink));
      set(`white${side}`, 'rx', f(rx)); set(`white${side}`, 'ry', f(ry));
      set(`eye${side}Clip`, 'rx', f(rx)); set(`eye${side}Clip`, 'ry', f(ry));
      const closed = ry < 2.2;
      set(`lid${side}`, 'd', closed
        ? `M${f(-rx)},0Q0,6 ${f(rx)},0`
        : `M${f(-rx - 1)},0Q0,${f(-ry * 2 - 1)} ${f(rx + 1)},0`);
      set(`iris${side}G`, 'transform',
        `translate(${f(p.gazeX * 8 + yaw * 3)},${f(-p.gazeY * 5 + pitch * 2)})`);
      e[`white${side}`].style.display = closed ? 'none' : '';
    }

    // Brows: inner ends rise with worry/surprise and drop with a scowl.
    const lift = p.browUp * 8 + p.browOuterUp * 8 - p.browDown * 6 + p.wide * 4;
    const inner = p.browUp * 8 - p.browDown * 8;
    const outer = p.browOuterUp * 6;
    const by = 152 - lift;
    set('browL', 'd', `M134,${f(by + 4 - outer)}Q156,${f(by - 8)} 182,${f(by + 2 - inner)}`);
    set('browR', 'd', `M218,${f(by + 2 - inner)}Q244,${f(by - 8)} 266,${f(by + 4 - outer)}`);

    // Mouth.
    const cx = 200, cy = 250;
    const w = 30 * (1 + p.smile * 0.35 - p.pucker * 0.45 - p.funnel * 0.3);
    const corner = cy - p.smile * 12 + p.frown * 10;
    const h = p.jaw * 44 + p.funnel * 12;
    const upperMid = cy + p.smile * 3 - h * 0.18 - p.frown * 2;
    const lowerMid = cy + p.smile * 7 + h * 0.85 - p.frown * 3;
    const ctrl = (mid) => 2 * mid - corner; // quadratic control point for a curve whose midpoint is `mid`
    const d = `M${f(cx - w)},${f(corner)}Q${cx},${f(ctrl(upperMid))} ${f(cx + w)},${f(corner)}Q${cx},${f(ctrl(lowerMid))} ${f(cx - w)},${f(corner)}Z`;
    const isOpen = lowerMid - upperMid > 3;
    set('mouth', 'd', d); set('mouthClip', 'd', d);
    e.mouth.style.display = isOpen ? '' : 'none';
    set('mouthLine', 'd', `M${f(cx - w)},${f(corner)}Q${cx},${f(ctrl((upperMid + lowerMid) / 2))} ${f(cx + w)},${f(corner)}`);
    e.mouthLine.style.display = isOpen ? 'none' : '';
    set('teeth', 'y', f(upperMid - 8));
    set('tongue', 'cy', f(lowerMid + 2));

    const blush = 0.12 + p.smile * 0.35 + p.cheekPuff * 0.2;
    for (const k of ['cheekL', 'cheekR']) { set(k, 'fill-opacity', f(blush)); set(k, 'r', f(16 + p.cheekPuff * 6)); }
  }
}

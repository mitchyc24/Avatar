// User-supplied SVG avatars: sanitizing, validating and animating them.
//
// A custom avatar is any SVG whose animatable pieces carry well-known ids
// (see docs/custom-avatars.md). Each named part is wrapped in a <g> whose
// transform/opacity we drive from the pose, so the artwork's own transforms
// are left untouched and any drawing style works.
//
// SVGs are untrusted (they come from files and from the other peer), so they
// are rebuilt from an allowlist: no scripts, event handlers, foreign content,
// external references or global CSS survive.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export const MAX_SVG_BYTES = 200 * 1024; // after sanitizing; also what we send to the peer
export const MAX_UPLOAD_BYTES = 1024 * 1024;

export const PARTS = {
  head: 'Everything that moves with the head (required)',
  body: 'Neck, shoulders, clothes',
  'hair-back': 'Hair behind the head',
  ears: 'Both ears',
  'eye-left': 'Open eye on the left of the picture (white + iris + pupil)',
  'eye-right': 'Open eye on the right of the picture',
  'pupil-left': 'Iris/pupil inside eye-left; slides to show gaze',
  'pupil-right': 'Iris/pupil inside eye-right',
  'eye-left-closed': 'Closed-eye drawing shown when blinking',
  'eye-right-closed': 'Closed-eye drawing shown when blinking',
  'brow-left': 'Eyebrow on the left of the picture',
  'brow-right': 'Eyebrow on the right of the picture',
  nose: 'Nose',
  mouth: 'Closed, neutral mouth',
  'mouth-open': 'Open mouth (shown and stretched while talking)',
  'mouth-smile': 'Closed smiling mouth',
  jaw: 'Chin/beard that drops when the mouth opens',
  cheeks: 'Blush, stronger when smiling',
  glasses: 'Glasses',
  'hair-front': 'Fringe/bangs drawn over the face',
};
const RECOMMENDED = ['eye-left', 'eye-right', 'pupil-left', 'pupil-right', 'mouth'];

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'title', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'use', 'symbol', 'image', 'text', 'tspan',
  'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'femerge',
  'femergenode', 'fedropshadow', 'femorphology',
]);
// Content of these is dropped entirely (not unwrapped).
const DROP_TAGS = new Set(['script', 'style', 'foreignobject', 'iframe', 'animate', 'set', 'animatetransform', 'animatemotion']);

const PRESENTATION = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'stop-color', 'stop-opacity', 'clip-path',
  'clip-rule', 'mask', 'filter', 'display', 'visibility', 'color', 'flood-color', 'flood-opacity', 'paint-order',
  'vector-effect', 'shape-rendering', 'mix-blend-mode', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'letter-spacing',
];
const ALLOWED_ATTRS = new Set([
  ...PRESENTATION, 'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'width', 'height', 'points', 'viewbox', 'preserveaspectratio', 'transform', 'offset', 'gradientunits',
  'gradienttransform', 'spreadmethod', 'clippathunits', 'maskunits', 'maskcontentunits', 'patternunits',
  'patterncontentunits', 'patterntransform', 'filterunits', 'primitiveunits', 'stddeviation', 'dx', 'dy', 'in',
  'in2', 'result', 'mode', 'values', 'type', 'operator', 'k1', 'k2', 'k3', 'k4', 'radius', 'pathlength', 'style',
]);
const STYLE_PROPS = new Set(PRESENTATION);

const URL_RE = /url\s*\(/i;
const LOCAL_URL_RE = /url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi;
const RASTER_DATA_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function safeValue(value) {
  if (/javascript:|data:|expression\s*\(|@import|\\|<|>/i.test(value)) return false;
  // Only fragment references like url(#grad) are allowed.
  return !URL_RE.test(value.replace(LOCAL_URL_RE, ''));
}

function sanitizeStyle(text, warn) {
  const out = [];
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!value) continue;
    if (STYLE_PROPS.has(prop) && safeValue(value)) out.push(`${prop}:${value}`);
    else warn(`Ignored style "${prop}"`);
  }
  return out.join(';');
}

// Turn simple <style> rules (".skin { fill: #c96 }") into inline styles, since
// global CSS would leak out of the avatar into the page.
function inlineStyleSheets(doc, warn) {
  const sheets = [...doc.getElementsByTagNameNS(SVG_NS, 'style')];
  if (!sheets.length) return new Map();
  const styles = new Map();
  for (const sheet of sheets) {
    const css = sheet.textContent.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const raw of selectors.split(',')) {
        const sel = raw.trim();
        if (!/^([a-zA-Z][\w-]*)?([.#][\w-]+)?$/.test(sel) || !sel) {
          warn(`Ignored CSS selector "${sel.slice(0, 40)}"`);
          continue;
        }
        let matches;
        try { matches = doc.querySelectorAll(sel); } catch { continue; }
        for (const el of matches) styles.set(el, `${styles.get(el) || ''};${body}`);
      }
    }
  }
  return styles;
}

/**
 * Validate and clean an SVG string.
 * Returns { ok, svg, parts, warnings, error }.
 */
export function sanitizeSvg(text) {
  const warnings = new Set();
  const warn = (w) => warnings.add(w);
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'The file is larger than 1 MB.' };

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    return { ok: false, error: 'This is not a valid SVG file (it could not be read as SVG).' };
  }
  const sheetStyles = inlineStyleSheets(doc, warn);

  const out = document.implementation.createDocument(SVG_NS, 'svg', null);
  const copy = (src, dst) => {
    for (const attr of src.attributes) {
      const name = attr.localName.toLowerCase();
      const value = attr.value;
      if (name === 'href' && (attr.namespaceURI === XLINK_NS || !attr.namespaceURI)) {
        const tag = src.localName.toLowerCase();
        if (value.startsWith('#') && /^#[\w.:-]+$/.test(value) && tag !== 'image') dst.setAttribute('href', value);
        else if (tag === 'image' && RASTER_DATA_RE.test(value)) dst.setAttribute('href', value);
        else warn('Removed a link to an external file');
        continue;
      }
      if (attr.namespaceURI && attr.namespaceURI !== XLINK_NS) continue; // inkscape:, sodipodi:, xml:space …
      if (name === 'class') continue;
      if (name.startsWith('on')) { warn('Removed script code'); continue; }
      if (!ALLOWED_ATTRS.has(name)) continue;
      if (name === 'style') {
        const clean = sanitizeStyle(value, warn);
        if (clean) dst.setAttribute('style', clean);
        continue;
      }
      if (!safeValue(value)) { warn(`Removed unsafe "${name}" value`); continue; }
      dst.setAttribute(attr.localName === 'viewbox' ? 'viewBox' : attr.localName, value);
    }
    const sheet = sheetStyles.get(src);
    if (sheet) {
      const clean = sanitizeStyle(sheet, warn);
      if (clean) dst.setAttribute('style', [clean, dst.getAttribute('style')].filter(Boolean).join(';'));
    }
    for (const child of src.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (['text', 'tspan', 'title', 'desc'].includes(src.localName.toLowerCase())) dst.appendChild(out.createTextNode(child.data));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName.toLowerCase();
      if (child.namespaceURI !== SVG_NS) { if (tag !== 'namedview' && tag !== 'metadata') warn(`Removed <${child.localName}>`); continue; }
      if (DROP_TAGS.has(tag)) { if (tag === 'script' || tag === 'foreignobject') warn(`Removed <${child.localName}>`); continue; }
      if (!ALLOWED_TAGS.has(tag) && tag !== 'a') { warn(`Removed unsupported <${child.localName}>`); continue; }
      // A link becomes a plain group: keep the drawing, drop the link.
      const el = out.createElementNS(SVG_NS, tag === 'a' ? 'g' : child.localName);
      copy(child, el);
      dst.appendChild(el);
    }
  };
  copy(root, out.documentElement);
  const svgEl = out.documentElement;

  // Normalise the canvas to a viewBox.
  if (!svgEl.getAttribute('viewBox')) {
    const w = parseFloat(root.getAttribute('width')), h = parseFloat(root.getAttribute('height'));
    if (w > 0 && h > 0) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    else return { ok: false, error: 'The SVG needs a viewBox (for example viewBox="0 0 400 400").' };
  }
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');

  const parts = findParts(svgEl);
  if (!parts.head) warn('No "head" part, so the whole picture will move as one piece.');
  const missing = RECOMMENDED.filter((p) => !parts[p]);
  if (missing.length) warn(`Missing ${missing.map((m) => `"${m}"`).join(', ')}. Those features won't animate.`);

  const svg = new XMLSerializer().serializeToString(out);
  if (svg.length > MAX_SVG_BYTES) {
    return { ok: false, error: `The SVG is too large (${Math.round(svg.length / 1024)} KB after cleaning; the limit is ${MAX_SVG_BYTES / 1024} KB). Simplify it or remove embedded images.` };
  }
  return { ok: true, svg, parts: Object.keys(parts), warnings: [...warnings] };
}

// "eyeLeft", "eye_left", "Eye-Left" → "eye-left"
export function partName(id) {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
}

function findParts(svg) {
  const parts = {};
  for (const el of svg.querySelectorAll('[id]')) {
    const name = partName(el.getAttribute('id'));
    if (name in PARTS && !parts[name]) parts[name] = el;
  }
  return parts;
}

let instances = 0;

export class CustomRig {
  constructor(container, svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    const prefix = `cu${++instances}-`;

    // Find parts by their original ids, then make every id unique on the page.
    const parts = findParts(svg);
    const ids = new Map();
    for (const el of svg.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      ids.set(id, prefix + id);
      el.setAttribute('id', prefix + id);
    }
    const rewrite = (v) => v.replace(/url\(\s*(['"]?)#([\w.:-]+)\1\s*\)/g, (m, q, id) => (ids.has(id) ? `url(#${ids.get(id)})` : m));
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.localName === 'href' && attr.value.startsWith('#') && ids.has(attr.value.slice(1))) {
          el.setAttribute('href', `#${ids.get(attr.value.slice(1))}`);
        } else if (attr.value.includes('url(')) {
          el.setAttribute(attr.name, rewrite(attr.value));
        }
      }
    }

    if (!parts.head) {
      const g = document.createElementNS(SVG_NS, 'g');
      for (const child of [...svg.childNodes]) if (child.localName !== 'defs') g.appendChild(child);
      svg.appendChild(g);
      parts.head = g;
    }

    // Wrap each part so we own its transform and opacity.
    this.w = {};
    for (const [name, el] of Object.entries(parts)) {
      const g = document.createElementNS(SVG_NS, 'g');
      el.parentNode.insertBefore(g, el);
      g.appendChild(el);
      this.w[name] = g;
    }
    for (const side of ['left', 'right']) {
      const pupil = this.w[`pupil-${side}`], eye = this.w[`eye-${side}`];
      this[`pupilInside_${side}`] = !!(pupil && eye && eye.contains(pupil));
    }

    svg.setAttribute('class', 'avatar-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    this.svg = svg;
    container.appendChild(svg);
    this.boxes = null;
  }

  // Bounding boxes need the SVG to be laid out, so measure on the first visible frame.
  measure() {
    const boxes = {};
    for (const [name, g] of Object.entries(this.w)) {
      let b;
      try { b = g.getBBox(); } catch { return false; }
      boxes[name] = { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    }
    if (!boxes.head.w || !boxes.head.h) return false;
    this.boxes = boxes;
    return true;
  }

  render(p, now, breathe) {
    if (!this.boxes && !this.measure()) return;
    const w = this.w, b = this.boxes;
    const f = (v) => v.toFixed(2);
    const set = (name, transform, opacity) => {
      const g = w[name];
      if (!g) return;
      if (transform != null) g.setAttribute('transform', transform);
      if (opacity != null) g.setAttribute('opacity', f(opacity));
    };
    const about = (box, inner) => `translate(${f(box.cx)} ${f(box.cy)}) ${inner} translate(${f(-box.cx)} ${f(-box.cy)})`;

    const head = b.head;
    const S = Math.max(head.w, head.h * 0.8); // reference size for all motion
    const breath = breathe * S / 180; // built-in avatar units → this drawing's units
    const hx = p.x * 0.2 * S, hy = p.y * 0.15 * S + breath;
    const sc = 1 + p.scale * 0.15;
    const pivotY = head.y + head.h * 0.85;
    set('head', `translate(${f(hx)} ${f(hy)}) rotate(${f(p.roll * 45)} ${f(head.cx)} ${f(pivotY)}) ${about(head, `scale(${f(sc)})`)}`);
    set('body', `translate(${f(hx * 0.45)} ${f(breath * 0.6)})`);

    const par = (kx, ky) => [p.yaw * kx * S, p.pitch * ky * S];
    const tr = ([x, y]) => `translate(${f(x)} ${f(y)})`;
    const face = par(0.16, 0.12);
    set('hair-back', tr(par(-0.03, -0.03)));
    set('ears', tr(par(-0.07, -0.04)));
    set('hair-front', tr(par(0.065, 0.045)));
    set('nose', tr(par(0.22, 0.14)));
    set('glasses', tr(face));
    set('cheeks', tr(par(0.12, 0.09)), Math.min(1, 0.35 + p.smile * 0.65 + p.cheekPuff * 0.3));
    set('jaw', `translate(${f(face[0] * 0.8)} ${f(face[1] * 0.8 + p.jaw * 0.05 * S)})`);

    // Eyes: squash vertically to blink, or swap to the closed drawing if there is one.
    const open = 1 + p.wide * 0.3 - p.squint * 0.35 - p.smile * 0.1;
    for (const side of ['left', 'right']) {
      const eye = `eye-${side}`;
      if (!b[eye]) continue;
      const blink = side === 'left' ? p.blinkL : p.blinkR;
      const sy = Math.max(0.06, Math.min(1.3, open * (1 - blink)));
      const closedName = `${eye}-closed`;
      const useClosed = !!w[closedName] && sy < 0.35;
      const eyeT = `${tr(face)} ${about(b[eye], `scale(1 ${f(useClosed ? 1 : sy)})`)}`;
      set(eye, eyeT, useClosed ? 0 : 1);
      set(closedName, tr(face), useClosed ? 1 : 0);
      const pupil = `pupil-${side}`;
      if (b[pupil]) {
        const gaze = `translate(${f(p.gazeX * 0.22 * b[eye].w + p.yaw * 0.05 * b[eye].w)} ${f(-p.gazeY * 0.2 * b[eye].h)})`;
        // A pupil drawn outside its eye group has to follow the eye itself.
        set(pupil, this[`pupilInside_${side}`] ? gaze : `${eyeT} ${gaze}`, useClosed ? 0 : 1);
      }
    }

    // Brows: lift together; inner ends rise when worried and drop when scowling.
    const lift = (p.browUp * 0.5 + p.browOuterUp * 0.5 - p.browDown * 0.45 + p.wide * 0.2) * 0.06 * S;
    const tilt = (p.browUp - p.browDown) * 12;
    if (b['brow-left']) set('brow-left', `translate(${f(face[0])} ${f(face[1] - lift)}) ${about(b['brow-left'], `rotate(${f(-tilt)})`)}`);
    if (b['brow-right']) set('brow-right', `translate(${f(face[0])} ${f(face[1] - lift)}) ${about(b['brow-right'], `rotate(${f(tilt)})`)}`);

    // Mouth: stretch an open-mouth drawing while talking, else squash/stretch the closed one.
    const openness = Math.min(1, p.jaw + p.funnel * 0.3);
    const sx = 1 + p.smile * 0.18 - p.pucker * 0.35 - p.funnel * 0.2;
    if (b.mouth || b['mouth-open']) {
      const talking = !!b['mouth-open'] && openness > 0.08;
      const smiling = !talking && !!b['mouth-smile'] && p.smile > 0.45;
      if (b['mouth-open']) {
        const mo = b['mouth-open'];
        const sy = Math.max(0.2, Math.min(1, openness * 1.3));
        // Anchor at the top edge so the lower lip drops like a jaw.
        set('mouth-open', `${tr(face)} translate(${f(mo.cx)} ${f(mo.y)}) scale(${f(sx)} ${f(sy)}) translate(${f(-mo.cx)} ${f(-mo.y)})`, talking ? 1 : 0);
      }
      if (b['mouth-smile']) set('mouth-smile', `${tr(face)} ${about(b['mouth-smile'], `scale(${f(sx)} 1)`)}`, smiling ? 1 : 0);
      if (b.mouth) {
        const sy = b['mouth-open'] ? 1 : 1 + openness * 2.2;
        set('mouth', `${tr(face)} ${about(b.mouth, `scale(${f(sx)} ${f(sy)})`)}`, talking || smiling ? 0 : 1);
      }
    }
  }

  destroy() { this.svg.remove(); }
}

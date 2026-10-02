import { ensureAudioContext, levelMeter } from './audio.js';
import { CastSender } from './cast.js';
import { sanitizeSvg, SvgAssembler, svgMessages } from './custom-avatar.js';
import { AvatarView, FACIAL_HAIR, GLASSES, HAIR_STYLES, PALETTES, randomStyle, sanitizeStyle } from './avatar.js';
import { decodePose, encodePose, isNewer, neutralPose } from './protocol.js';
import { Call, newRoomId } from './rtc.js';

const $ = (id) => document.getElementById(id);
const STYLE_KEY = 'avatar-call.style';
const SVG_KEY = 'avatar-call.svg';
// Routes live in the URL fragment (#room=…, #cast) so the app works from any
// sub-path, e.g. GitHub Pages, and room ids never reach a server log.
const ROOM_HASH_RE = /^#room=([A-Za-z0-9_-]{10,64})$/;
const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const COLOR_NAMES = {
  skin: ['Light', 'Fair', 'Medium', 'Tan', 'Brown', 'Deep'],
  hair: ['Black', 'Dark brown', 'Brown', 'Auburn', 'Blonde', 'Red', 'Grey', 'White', 'Blue', 'Purple', 'Green'],
  eyes: ['Brown', 'Blue', 'Green', 'Hazel', 'Grey'],
  shirt: ['Blue', 'Red', 'Green', 'Yellow', 'Purple', 'Charcoal', 'Cream', 'Pink'],
  bg: ['Sky', 'Peach', 'Mint', 'Lavender', 'Butter', 'Silver', 'Navy', 'Plum'],
};
const OPTION_GROUPS = [
  { key: 'skin', legend: 'Skin tone', colors: true },
  { key: 'hairStyle', legend: 'Hair style', options: ['Short', 'Long', 'Bun', 'Curly', 'Spiky', 'Bald'] },
  { key: 'hair', legend: 'Hair colour', colors: true },
  { key: 'eyes', legend: 'Eye colour', colors: true },
  { key: 'facialHair', legend: 'Facial hair', options: ['None', 'Stubble', 'Beard', 'Moustache'] },
  { key: 'glasses', legend: 'Glasses', options: ['None', 'Round', 'Square'] },
  { key: 'shirt', legend: 'Shirt', colors: true },
  { key: 'bg', legend: 'Background', colors: true },
];
console.assert(HAIR_STYLES.length === 6 && GLASSES.length === 3 && FACIAL_HAIR.length === 4);

const state = {
  config: { iceServers: DEFAULT_ICE_SERVERS, publicUrl: null },
  serverless: false, // true on static hosting (GitHub Pages): no call server, Cast mode only
  room: null,
  style: loadStyle(),
  stream: null,
  micTrack: null,
  camTrack: null,
  tracker: null,
  trackerReady: null,
  call: null,
  seq: 0,
  lastRemoteSeq: null,
  remoteMeter: null,
  localMeter: null,
  unread: 0,
  customSvg: null, // sanitized SVG text of our own custom avatar
  cast: null, // CastSender while in Cast mode
  castVoice: true,
};

// ---------------------------------------------------------------- helpers

function loadStyle() {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw) return sanitizeStyle(JSON.parse(raw));
  } catch { /* storage unavailable */ }
  return randomStyle();
}

function saveStyle() {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(state.style)); } catch { /* ignore */ }
}

function show(id) {
  for (const s of ['landing', 'lobby', 'cast', 'call', 'ended', 'error']) $(s).hidden = s !== id;
  document.body.dataset.screen = id;
}

function announce(text) {
  const a = $('announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = text; }, 50);
}

function fatal(text) {
  $('error-text').textContent = text;
  show('error');
}

function inviteUrl() {
  const base = state.config.publicUrl ? `${state.config.publicUrl}/` : location.origin + location.pathname;
  return `${base}#room=${state.room}`;
}

const isLocalOnly = () => !state.config.publicUrl && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// ---------------------------------------------------------------- avatars

const selfSlot = document.createElement('div');
selfSlot.className = 'avatar-holder';
const selfAvatar = new AvatarView(selfSlot, { mirrored: true, label: 'you' });
selfAvatar.setStyle(state.style);
selfAvatar.start();
const remoteAvatar = new AvatarView($('remote-avatar'), { label: 'your friend' });
remoteAvatar.setPose(neutralPose());

// The preview avatar, device controls and customization form are shared by
// the call lobby and Cast mode, so they move to whichever screen is showing.
function placeSelfAvatar(where) {
  $(`self-slot-${where}`).appendChild(selfSlot);
  if (where === 'lobby' || where === 'cast') {
    $(`device-slot-${where}`).appendChild($('device-row'));
    $(`customize-slot-${where}`).appendChild($('style-form'));
  }
}

function tickMeters() {
  selfAvatar.setAudioLevel(state.localMeter && state.micTrack?.enabled ? state.localMeter() : 0);
  const remoteLevel = state.remoteMeter ? state.remoteMeter() : 0;
  remoteAvatar.setAudioLevel(remoteLevel);
  $('remote-tile').classList.toggle('speaking', remoteLevel > 0.04);
  requestAnimationFrame(tickMeters);
}
requestAnimationFrame(tickMeters);

// ---------------------------------------------------------------- customization

function buildSwatches() {
  const root = $('swatches');
  for (const group of OPTION_GROUPS) {
    const fs = document.createElement('fieldset');
    fs.className = group.colors ? 'swatch-group' : 'option-group';
    if (group.key !== 'bg') fs.classList.add('builtin-only');
    const legend = document.createElement('legend');
    legend.textContent = group.legend;
    fs.appendChild(legend);
    const labels = group.colors ? COLOR_NAMES[group.key] : group.options;
    labels.forEach((text, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = group.key;
      input.value = String(i);
      input.checked = state.style[group.key] === i;
      label.appendChild(input);
      const face = document.createElement('span');
      if (group.colors) {
        face.className = 'swatch';
        face.style.setProperty('--c', PALETTES[group.key][i]);
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = text;
        label.appendChild(sr);
        label.title = text;
      } else {
        face.className = 'chip';
        face.textContent = text;
      }
      label.appendChild(face);
      fs.appendChild(label);
    });
    root.appendChild(fs);
  }
  $('name-input').value = state.style.name;
}

function syncSwatches() {
  for (const group of OPTION_GROUPS) {
    const input = document.querySelector(`input[name="${group.key}"][value="${state.style[group.key]}"]`);
    if (input) input.checked = true;
  }
  $('name-input').value = state.style.name;
}

function updateStyle(patch) {
  state.style = sanitizeStyle({ ...state.style, ...patch });
  selfAvatar.setStyle(state.style);
  saveStyle();
  for (const sink of sinks()) sink.sendMessage({ t: 'profile', style: state.style });
}

// Everything that receives our avatar: the call peer and any TVs.
const sinks = () => [state.call, state.cast].filter(Boolean);

$('style-form').addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.type === 'radio') updateStyle({ [t.name]: Number(t.value) });
});
$('name-input').addEventListener('input', (ev) => updateStyle({ name: ev.target.value }));
$('style-form').addEventListener('submit', (ev) => ev.preventDefault());
$('randomize-btn').addEventListener('click', () => {
  updateStyle({ ...randomStyle(), name: state.style.name });
  syncSwatches();
});

// ---------------------------------------------------------------- camera, mic, tracking

async function getMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext
      ? 'This browser cannot use a camera or microphone.'
      : 'Camera and microphone need a secure (https) link. Open the https invite link instead.');
  }
  const video = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const attempts = [{ video, audio }, { audio }, { video }];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' && constraints.video && constraints.audio) continue;
      if (err.name !== 'NotFoundError' && err.name !== 'NotReadableError' && err.name !== 'OverconstrainedError' && err.name !== 'NotAllowedError') break;
    }
  }
  throw lastErr;
}

function describeMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError': return 'Permission was blocked. Allow the camera and microphone in your browser\'s site settings (usually the icon by the address bar), then try again.';
    case 'NotFoundError': return 'No camera or microphone was found.';
    case 'NotReadableError': return 'Your camera or microphone is in use by another app.';
    default: return err?.message || 'Could not start the camera or microphone.';
  }
}

async function enableMedia() {
  const btn = $('media-btn');
  btn.disabled = true;
  ensureAudioContext();
  $('media-status').textContent = 'Waiting for permission…';
  try {
    const stream = await getMedia();
    attachStream(stream);
  } catch (err) {
    $('media-status').textContent = describeMediaError(err);
    btn.disabled = false;
    return;
  }
  btn.hidden = true;
  updateMediaStatus();
}

function attachStream(stream) {
  const mic = stream.getAudioTracks()[0];
  const cam = stream.getVideoTracks()[0];
  if (mic) {
    state.micTrack?.stop();
    state.micTrack = mic;
    state.localMeter?.disconnect?.();
    state.localMeter = levelMeter(new MediaStream([mic]));
    state.call?.setMicTrack(mic);
    state.cast?.setMicTrack(state.castVoice ? mic : null);
  }
  if (cam) startTracking(cam);
}

async function startTracking(track) {
  state.camTrack?.stop();
  state.camTrack = track;
  const video = $('camera');
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  track.addEventListener('ended', () => { if (state.camTrack === track) stopTracking(); });
  $('media-status').textContent = 'Loading face tracking…';
  try {
    if (!state.trackerReady) {
      state.trackerReady = import('./tracker.js').then(async ({ FaceTracker }) => {
        const t = new FaceTracker();
        await t.init();
        state.tracker = t;
        return t;
      });
    }
    const tracker = await state.trackerReady;
    if (state.camTrack !== track) return;
    tracker.recenter();
    tracker.start(video, onLocalPose);
  } catch (err) {
    console.error(err);
    state.trackerReady = null;
    $('media-status').textContent = 'Face tracking could not start on this device. Your avatar will still talk when you do.';
  }
  updateMediaStatus();
}

function stopTracking() {
  state.tracker?.stop();
  state.camTrack?.stop();
  state.camTrack = null;
  $('camera').srcObject = null;
  const idle = neutralPose();
  selfAvatar.setPose(idle);
  const bytes = encodePose(idle, nextSeq());
  for (const sink of sinks()) sink.sendPose(bytes);
  updateMediaStatus();
}

const nextSeq = () => (state.seq = (state.seq + 1) & 0xffff);

function onLocalPose(pose) {
  selfAvatar.setPose(pose);
  const bytes = encodePose(pose, nextSeq());
  for (const sink of sinks()) sink.sendPose(bytes);
}

function updateMediaStatus() {
  const cam = !!state.camTrack, mic = !!state.micTrack;
  if (state.tracker || !cam) {
    $('media-status').textContent = cam && mic ? 'Camera and microphone are on. Try smiling, blinking or turning your head.'
      : cam ? 'Camera is on, but there is no microphone. You can still use chat.'
        : mic ? 'Microphone is on. Without the camera your avatar moves its mouth when you talk.'
          : 'Camera and microphone are off. You can still join and use chat.';
  }
  const camBtn = $('cam-btn');
  camBtn.setAttribute('aria-pressed', String(!cam));
  camBtn.querySelector('span').textContent = cam ? 'Stop tracking' : 'Start tracking';
  const micBtn = $('mic-btn');
  const muted = !mic || !state.micTrack.enabled;
  micBtn.setAttribute('aria-pressed', String(muted));
  micBtn.querySelector('span').textContent = !mic ? 'No mic' : muted ? 'Unmute' : 'Mute';
  micBtn.disabled = !mic && !navigator.mediaDevices;
  $('self-muted').hidden = !muted;
  $('recenter-btn').disabled = !cam;
}

// ---------------------------------------------------------------- invite link

async function refreshConfig() {
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
    state.serverless = false;
  } catch {
    // Static hosting (e.g. GitHub Pages): there's no signaling server, so only Cast mode works.
    state.serverless = true;
  }
}

function renderInvite() {
  if (!state.room) return;
  $('invite-box').hidden = false;
  $('invite-url').value = inviteUrl();
  $('share-btn').hidden = !navigator.share;
  const warn = $('invite-warning');
  warn.hidden = !isLocalOnly();
  warn.textContent = 'This link only works on this computer. To invite someone, restart with ./avatar --share (a public link appears here within a few seconds).';
}

async function copyInvite(button) {
  const url = inviteUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = $('invite-url');
    input.select();
    document.execCommand?.('copy');
  }
  const old = button.textContent;
  button.textContent = 'Copied!';
  announce('Invite link copied');
  setTimeout(() => { button.textContent = old; }, 1600);
}

$('copy-btn').addEventListener('click', (ev) => copyInvite(ev.currentTarget));
$('waiting-invite-btn').addEventListener('click', (ev) => copyInvite(ev.currentTarget));
$('share-btn').addEventListener('click', () => {
  navigator.share({ title: 'Avatar Call', text: 'Join my avatar call', url: inviteUrl() }).catch(() => {});
});
$('invite-url').addEventListener('focus', (ev) => ev.target.select());

// Wait for the tunnel's public URL if the server is still opening it.
async function pollPublicUrl() {
  for (let i = 0; i < 20 && isLocalOnly(); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await refreshConfig();
    renderInvite();
  }
}

// ---------------------------------------------------------------- custom SVG avatar

function loadCustomSvg() {
  let raw = null;
  try { raw = localStorage.getItem(SVG_KEY); } catch { /* storage unavailable */ }
  if (!raw) return;
  const res = sanitizeSvg(raw);
  if (res.ok) applyCustomSvg(res, { quiet: true });
}

function applyCustomSvg(res, { quiet = false } = {}) {
  state.customSvg = res ? res.svg : null;
  selfAvatar.setCustomSvg(state.customSvg);
  $('style-form').classList.toggle('using-custom', !!res);
  $('svg-remove-btn').hidden = !res;
  try {
    if (res) localStorage.setItem(SVG_KEY, res.svg);
    else localStorage.removeItem(SVG_KEY);
  } catch { /* it just won't be remembered next time */ }
  if (!quiet) renderSvgReport(res);
  sendCustomSvg();
}

function renderSvgReport(res, error) {
  const box = $('svg-report');
  box.replaceChildren();
  box.className = 'svg-report';
  if (!res && !error) return;
  const head = document.createElement('p');
  if (error) {
    box.classList.add('error');
    head.textContent = `Couldn't use that SVG: ${error}`;
    box.append(head);
    return;
  }
  box.classList.add('ok');
  head.textContent = 'Custom avatar loaded.';
  const parts = document.createElement('div');
  parts.append('Animated parts: ');
  res.parts.forEach((name, i) => {
    if (i) parts.append(', ');
    const c = document.createElement('code');
    c.textContent = name;
    parts.append(c);
  });
  if (!res.parts.length) parts.append('none');
  box.append(head, parts);
  if (res.warnings.length) {
    const ul = document.createElement('ul');
    for (const w of res.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.append(li);
    }
    box.append(ul);
  }
}

function importSvgText(text) {
  const res = sanitizeSvg(text);
  if (!res.ok) {
    renderSvgReport(null, res.error);
    announce(`Couldn't use that SVG. ${res.error}`);
    return false;
  }
  applyCustomSvg(res);
  announce('Custom avatar loaded');
  return true;
}

async function importSvgFile(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) { renderSvgReport(null, 'the file is larger than 1 MB.'); return; }
  if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
    renderSvgReport(null, 'please choose an .svg file.');
    return;
  }
  importSvgText(await file.text());
}

// Send our custom SVG (or its removal) to the call peer and TVs, or to one sink.
function sendCustomSvg(only) {
  const messages = svgMessages(state.customSvg);
  for (const sink of only ? [only] : sinks()) for (const m of messages) sink.sendMessage(m);
}

const remoteSvgs = new SvgAssembler((svg) => remoteAvatar.setCustomSvg(svg));

$('svg-upload-btn').addEventListener('click', () => $('svg-file').click());
$('svg-file').addEventListener('change', (ev) => {
  importSvgFile(ev.target.files[0]);
  ev.target.value = '';
});
$('svg-paste-btn').addEventListener('click', () => {
  const box = $('svg-paste');
  box.hidden = !box.hidden;
  $('svg-paste-btn').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) $('svg-paste-input').focus();
});
$('svg-paste-apply').addEventListener('click', () => {
  // AI chats often wrap code in ``` fences; take just the <svg>…</svg>.
  const text = $('svg-paste-input').value;
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  if (importSvgText(m ? m[0] : text)) {
    $('svg-paste-input').value = '';
    $('svg-paste').hidden = true;
    $('svg-paste-btn').setAttribute('aria-expanded', 'false');
  }
});
$('svg-remove-btn').addEventListener('click', () => {
  applyCustomSvg(null);
  announce('Using the built-in avatar');
});
$('copy-prompt-btn').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  try {
    const text = await (await fetch('assets/avatar-prompt.txt')).text();
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Prompt copied!';
    announce('AI prompt copied. Paste it into ChatGPT along with a photo of yourself.');
  } catch {
    window.open('assets/avatar-prompt.txt', '_blank', 'noopener');
  }
  setTimeout(() => { btn.textContent = 'Copy AI prompt'; }, 2000);
});

// Drag an .svg straight onto the lobby preview.
const dropZone = selfSlot;
dropZone.addEventListener('dragover', (ev) => {
  if ([...(ev.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
    ev.preventDefault();
    dropZone.classList.add('drop-target');
  }
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-target'));
dropZone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dropZone.classList.remove('drop-target');
  importSvgFile(ev.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- chat

function addChat({ who, text, mine = false, system = false }) {
  const li = document.createElement('li');
  li.className = system ? 'sys' : mine ? 'mine' : 'theirs';
  if (!system) {
    const name = document.createElement('span');
    name.className = 'who';
    name.textContent = who;
    li.appendChild(name);
  }
  const body = document.createElement('span');
  body.className = 'text';
  body.textContent = text;
  li.appendChild(body);
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  li.appendChild(time);
  const log = $('chat-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(li);
  if (atBottom || mine) log.scrollTop = log.scrollHeight;
  if (!mine && !system && !chatVisible()) {
    state.unread++;
    $('unread').hidden = false;
    $('unread').textContent = String(state.unread);
  }
}

const remoteName = () => remoteAvatar.style?.name || 'Friend';
const chatVisible = () => getComputedStyle($('chat')).display !== 'none';

function setChatOpen(open) {
  document.body.classList.toggle('chat-open', open);
  $('chat-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    state.unread = 0;
    $('unread').hidden = true;
    $('chat-input').focus();
  } else {
    $('chat-btn').focus();
  }
}

$('chat-btn').addEventListener('click', () => setChatOpen(!document.body.classList.contains('chat-open')));
$('chat-close').addEventListener('click', () => setChatOpen(false));

$('chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (state.call?.sendMessage({ t: 'chat', text: text.slice(0, 2000) })) {
    addChat({ who: 'You', text, mine: true });
    input.value = '';
  }
});

function setChatEnabled(on) {
  $('chat-input').disabled = !on;
  $('chat-send').disabled = !on;
  $('chat-input').placeholder = on ? 'Type a message' : 'Connect to send messages';
}

// ---------------------------------------------------------------- call

const STATUS_TEXT = {
  connecting: 'Connecting…',
  waiting: 'Waiting for your friend',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  full: 'This call already has two people',
  left: 'Left',
};

function setStatus(s) {
  const pill = $('status-pill');
  pill.hidden = false;
  pill.dataset.state = s;
  pill.textContent = STATUS_TEXT[s] || s;
  const connected = s === 'connected';
  $('waiting').hidden = connected;
  $('waiting-text').textContent = s === 'full'
    ? 'This call already has two people in it. Trying again every few seconds…'
    : s === 'reconnecting' ? 'Connection interrupted. Reconnecting…'
      : s === 'connecting' ? 'Connecting to your friend…'
        : 'Waiting for your friend to join. Send them the invite link.';
  $('waiting-invite-btn').hidden = s === 'full';
}

function joinCall() {
  ensureAudioContext();
  show('call');
  placeSelfAvatar('call');
  remoteAvatar.start();
  setChatEnabled(false);
  updateMediaStatus();

  const call = new Call({ room: state.room, iceServers: state.config.iceServers });
  state.call = call;
  call.setMicTrack(state.micTrack);

  call.addEventListener('state', ({ detail }) => {
    setStatus(detail);
    if (detail === 'connected') announce(`Connected to ${remoteName()}`);
  });
  call.addEventListener('channel-open', () => {
    setChatEnabled(true);
    call.sendMessage({ t: 'profile', style: state.style });
    call.sendMessage({ t: 'status', muted: !state.micTrack?.enabled });
    sendCustomSvg(call);
  });
  call.addEventListener('channel-close', () => setChatEnabled(false));
  call.addEventListener('peer-left', () => {
    addChat({ system: true, text: `${remoteName()} left the call.` });
    announce(`${remoteName()} left the call`);
    resetRemote();
  });
  call.addEventListener('message', ({ detail: msg }) => {
    if (msg.t === 'chat' && typeof msg.text === 'string') {
      addChat({ who: remoteName(), text: msg.text.slice(0, 2000) });
    } else if (msg.t === 'profile') {
      const first = !remoteAvatar.style?.name && !$('remote-tile').dataset.joined;
      remoteAvatar.setStyle(msg.style);
      $('remote-name').textContent = remoteName();
      if (first) {
        $('remote-tile').dataset.joined = '1';
        addChat({ system: true, text: `${remoteName()} joined the call.` });
      }
    } else if (msg.t === 'status') {
      $('remote-muted').hidden = !msg.muted;
    } else if (msg.t === 'svg') {
      remoteSvgs.push(msg);
    }
  });
  call.addEventListener('pose', ({ detail }) => {
    const pose = decodePose(detail);
    if (pose && isNewer(pose.seq, state.lastRemoteSeq)) {
      state.lastRemoteSeq = pose.seq;
      remoteAvatar.setPose(pose);
    }
  });
  call.addEventListener('track', ({ detail: track }) => {
    const audio = $('remote-audio');
    const stream = new MediaStream([track]);
    audio.srcObject = stream;
    audio.play().then(() => { $('unmute-audio-btn').hidden = true; })
      .catch(() => { $('unmute-audio-btn').hidden = false; });
    state.remoteMeter?.disconnect?.();
    state.remoteMeter = levelMeter(stream);
  });
  call.addEventListener('route', ({ detail }) => {
    if (detail.relayed) console.info('Call is relayed through a TURN server');
  });

  call.connect();
}

function resetRemote() {
  state.lastRemoteSeq = null;
  remoteSvgs.reset();
  remoteAvatar.setCustomSvg(null);
  remoteAvatar.setPose(neutralPose());
  delete $('remote-tile').dataset.joined;
  $('remote-name').textContent = 'Waiting for your friend…';
  $('remote-muted').hidden = true;
  state.remoteMeter?.disconnect?.();
  state.remoteMeter = null;
  $('remote-audio').srcObject = null;
}

$('unmute-audio-btn').addEventListener('click', () => {
  ensureAudioContext();
  $('remote-audio').play().then(() => { $('unmute-audio-btn').hidden = true; }).catch(() => {});
});

$('mic-btn').addEventListener('click', async () => {
  if (!state.micTrack) {
    try {
      attachStream(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
    } catch (err) {
      addChat({ system: true, text: describeMediaError(err) });
    }
  } else {
    state.micTrack.enabled = !state.micTrack.enabled;
  }
  state.call?.sendMessage({ t: 'status', muted: !state.micTrack?.enabled });
  updateMediaStatus();
  announce(state.micTrack?.enabled ? 'Microphone on' : 'Microphone muted');
});

$('cam-btn').addEventListener('click', async () => {
  if (state.camTrack) {
    stopTracking();
    announce('Face tracking stopped. Camera is off.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    await startTracking(stream.getVideoTracks()[0]);
    announce('Face tracking on');
  } catch (err) {
    addChat({ system: true, text: describeMediaError(err) });
  }
});

$('recenter-btn').addEventListener('click', () => {
  state.tracker?.recenter();
  announce('Re-centering. Look straight at the screen.');
});

function leaveCall() {
  state.call?.leave();
  state.call = null;
  setChatEnabled(false);
  resetRemote();
  $('status-pill').hidden = true;
}

$('leave-btn').addEventListener('click', () => {
  leaveCall();
  show('ended');
});
$('rejoin-btn').addEventListener('click', joinCall);
window.addEventListener('pagehide', () => {
  state.call?.leave();
  state.cast?.closeAll(); // the TV app keeps running; reopening the page rejoins it
});

// ---------------------------------------------------------------- cast mode

function castStatus(text, tone = '') {
  const el = $('cast-status');
  el.textContent = text;
  el.dataset.tone = tone;
}

async function enterCast() {
  state.room = null;
  show('cast');
  placeSelfAvatar('cast');
  $('cast-voice').checked = state.castVoice;
  if (state.cast) { renderCastTargets(); return; }

  let appId = '';
  try {
    appId = (await (await fetch('cast-config.json', { cache: 'no-store' })).json()).receiverAppId || '';
  } catch { /* no config file */ }
  const sender = new CastSender({ appId, iceServers: state.config.iceServers || DEFAULT_ICE_SERVERS });
  state.cast = sender;
  sender.setMicTrack(state.castVoice ? state.micTrack : null);

  sender.addEventListener('target-ready', ({ detail: { target, warning } }) => {
    // Bring the new TV up to date: who we are, our drawing, and whether we're muted.
    target.sendMessage({ t: 'profile', style: state.style });
    for (const m of svgMessages(state.customSvg)) target.sendMessage(m);
    target.sendMessage({ t: 'status', muted: !state.castVoice || !state.micTrack?.enabled });
    renderCastTargets(warning);
    announce(`Casting to ${target.label}`);
  });
  sender.addEventListener('targets', () => renderCastTargets());
  sender.addEventListener('cast-state', () => renderCastTargets());

  castStatus('Checking for Cast support…');
  sender.status = await sender.init();
  renderCastTargets();
}

function renderCastTargets(warning) {
  const sender = state.cast;
  if (!sender) return;
  const tv = sender.castTarget;
  const previews = [...sender.targets].filter((t) => t.kind === 'preview').length;
  const castBtn = $('cast-btn');
  castBtn.disabled = sender.status !== 'ready' || !!tv;
  $('cast-stop-btn').hidden = !tv;

  if (warning) { castStatus(warning, 'warn'); return; }
  if (tv) {
    const live = tv.mode === 'webrtc' || tv.mode === 'fallback';
    castStatus(live ? `Casting to ${tv.label}${tv.mode === 'fallback' ? ' (avatar only, no voice)' : ''}.` : `Connecting to ${tv.label}…`, live ? 'ok' : '');
  } else if (sender.status === 'no-app-id') {
    castStatus('Casting isn\'t set up yet: add your Cast application ID to cast-config.json (see docs/casting.md). The preview window works without it.', 'warn');
  } else if (sender.status === 'unsupported') {
    castStatus('Casting needs Google Chrome (on a computer or Android). The preview window still works here.', 'warn');
  } else if (sender.castState === 'NO_DEVICES_AVAILABLE') {
    castStatus('No Cast devices found. Make sure your TV or Chromecast is on and on the same Wi-Fi.');
  } else if (sender.castState === 'CONNECTING') {
    castStatus('Connecting to your TV…');
  } else if (previews) {
    castStatus('Showing your avatar in the preview window.', 'ok');
  } else {
    castStatus(sender.status === 'ready' ? 'Ready to cast.' : '');
  }
}

$('cast-mode-btn').addEventListener('click', () => { location.hash = 'cast'; });
$('cast-btn').addEventListener('click', async () => {
  ensureAudioContext();
  if (!state.camTrack && !state.micTrack) enableMedia();
  try {
    await state.cast.requestSession();
  } catch (err) {
    if (err !== 'cancel' && err?.code !== 'cancel') console.warn('Cast session not started', err);
  }
});
$('cast-stop-btn').addEventListener('click', () => {
  state.cast?.stopCasting();
  announce('Stopped casting');
});
$('cast-preview-btn').addEventListener('click', () => {
  if (!state.camTrack && !state.micTrack) enableMedia();
  if (!state.cast?.openPreview(new URL('receiver.html', location.href).href)) {
    castStatus('The preview window was blocked. Allow pop-ups for this site and try again.', 'warn');
  }
});
$('cast-voice').addEventListener('change', (ev) => {
  state.castVoice = ev.target.checked;
  state.cast?.setMicTrack(state.castVoice ? state.micTrack : null);
  state.cast?.sendMessage({ t: 'status', muted: !state.castVoice || !state.micTrack?.enabled });
  announce(state.castVoice ? 'Your voice is going to the TV' : 'Your voice is no longer sent to the TV');
});
$('cast-recenter-btn').addEventListener('click', () => {
  state.tracker?.recenter();
  announce('Re-centering. Look straight at the screen.');
});

// ---------------------------------------------------------------- boot

async function enterRoom(room) {
  state.room = room;
  if (state.serverless) {
    fatal('This call link needs the Avatar Call server, which isn\'t running at this address. Ask the person who invited you for a new link.');
    return;
  }
  show('lobby');
  placeSelfAvatar('lobby');
  renderInvite();
  if (isLocalOnly()) pollPublicUrl();
}

$('start-btn').addEventListener('click', () => { location.hash = `room=${newRoomId()}`; });
$('media-btn').addEventListener('click', enableMedia);
$('join-btn').addEventListener('click', joinCall);

window.addEventListener('hashchange', () => {
  leaveCall();
  if (location.hash !== '#cast' && state.cast?.targets.size) {
    state.cast.stopCasting();
    state.cast.closeAll();
  }
  route();
});

function route() {
  const m = location.hash.match(ROOM_HASH_RE);
  if (m) enterRoom(m[1]);
  else if (location.hash === '#cast') enterCast();
  else {
    state.room = null;
    show('landing');
    placeSelfAvatar('lobby');
    $('start-btn').disabled = state.serverless;
    $('serverless-note').hidden = !state.serverless;
  }
}

async function boot() {
  buildSwatches();
  loadCustomSvg();
  if (!window.RTCPeerConnection) {
    fatal('This browser does not support peer-to-peer connections. Please open the link in a current version of Chrome, Edge, Firefox or Safari.');
    return;
  }
  await refreshConfig();
  route();
}

boot();

// Exposed for automated end-to-end tests only.
window.__avatarCall = { state, selfAvatar, remoteAvatar };

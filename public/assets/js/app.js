import { AvatarView, FACIAL_HAIR, GLASSES, HAIR_STYLES, PALETTES, randomStyle, sanitizeStyle } from './avatar.js';
import { decodePose, encodePose, isNewer, neutralPose } from './protocol.js';
import { Call, newRoomId } from './rtc.js';

const $ = (id) => document.getElementById(id);
const STYLE_KEY = 'avatar-call.style';
const ROOM_RE = /^\/r\/([A-Za-z0-9_-]{10,64})\/?$/;

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
  config: { iceServers: [], publicUrl: null },
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
  audioCtx: null,
  remoteMeter: null,
  localMeter: null,
  unread: 0,
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
  for (const s of ['landing', 'lobby', 'call', 'ended', 'error']) $(s).hidden = s !== id;
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
  const base = state.config.publicUrl || location.origin;
  return `${base}/r/${state.room}`;
}

const isLocalOnly = () => !state.config.publicUrl && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function ensureAudioContext() {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) state.audioCtx = new Ctx();
  }
  state.audioCtx?.resume?.().catch(() => {});
  return state.audioCtx;
}

// Returns a function giving the current loudness (0..1) of a stream.
function levelMeter(stream) {
  const ctx = ensureAudioContext();
  if (!ctx) return () => 0;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
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

// ---------------------------------------------------------------- avatars

const selfSlot = document.createElement('div');
selfSlot.className = 'avatar-holder';
const selfAvatar = new AvatarView(selfSlot, { mirrored: true, label: 'you' });
selfAvatar.setStyle(state.style);
selfAvatar.start();
const remoteAvatar = new AvatarView($('remote-avatar'), { label: 'your friend' });
remoteAvatar.setPose(neutralPose());

function placeSelfAvatar(where) {
  $(where === 'call' ? 'self-slot-call' : 'self-slot-lobby').appendChild(selfSlot);
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
  state.call?.sendMessage({ t: 'profile', style: state.style });
}

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
  state.call?.sendPose(encodePose(idle, nextSeq()));
  updateMediaStatus();
}

const nextSeq = () => (state.seq = (state.seq + 1) & 0xffff);

function onLocalPose(pose) {
  selfAvatar.setPose(pose);
  state.call?.sendPose(encodePose(pose, nextSeq()));
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
    const res = await fetch('/api/config', { cache: 'no-store' });
    state.config = await res.json();
  } catch { /* keep previous */ }
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
window.addEventListener('pagehide', () => state.call?.leave());

// ---------------------------------------------------------------- boot

async function enterRoom(room) {
  state.room = room;
  show('lobby');
  placeSelfAvatar('lobby');
  renderInvite();
  if (isLocalOnly()) pollPublicUrl();
}

$('start-btn').addEventListener('click', () => {
  const room = newRoomId();
  history.pushState({}, '', `/r/${room}`);
  enterRoom(room);
});
$('media-btn').addEventListener('click', enableMedia);
$('join-btn').addEventListener('click', joinCall);

window.addEventListener('popstate', () => {
  leaveCall();
  route();
});

function route() {
  const m = location.pathname.match(ROOM_RE);
  if (m) enterRoom(m[1]);
  else { state.room = null; show('landing'); placeSelfAvatar('lobby'); }
}

async function boot() {
  buildSwatches();
  if (!window.RTCPeerConnection) {
    fatal('This browser does not support peer-to-peer calls. Please open the link in a current version of Chrome, Edge, Firefox or Safari.');
    return;
  }
  await refreshConfig();
  route();
}

boot();

// Exposed for automated end-to-end tests only.
window.__avatarCall = { state, selfAvatar, remoteAvatar };

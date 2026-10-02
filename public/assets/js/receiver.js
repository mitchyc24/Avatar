// Cast mode, TV side. Runs as a Google Cast Custom Web Receiver on the TV, or
// in an ordinary browser window as a preview (#preview=<id>, BroadcastChannel).
// Shows one sender's avatar full screen and plays their voice.
import { levelMeter } from './audio.js';
import { AvatarView } from './avatar.js';
import { CAST_NAMESPACE } from './cast.js';
import { SvgAssembler } from './custom-avatar.js';
import { PeerLink } from './peer.js';
import { decodePose, isNewer, neutralPose } from './protocol.js';

const CAF_URL = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const NO_SENDER_EXIT_MS = 30000;

const $ = (id) => document.getElementById(id);
const previewId = location.hash.match(/^#preview=([a-z0-9]+)$/)?.[1];

const avatar = new AvatarView($('avatar'), { label: 'the person casting' });
avatar.setPose(neutralPose());
avatar.start({ maxFps: previewId ? 60 : 30 });

let session = null; // { from, link, meter }
let lastSeq = null;
let send = () => {};
const svgs = new SvgAssembler((svg) => avatar.setCustomSvg(svg));

function showIdle(text) {
  $('idle').hidden = false;
  $('label').hidden = true;
  $('idle-text').textContent = text;
}

function showStage() {
  $('idle').hidden = true;
  $('label').hidden = !avatar.style?.name;
}

function notice(text) {
  const n = $('notice');
  n.textContent = text || '';
  n.hidden = !text;
}

// ------------------------------------------------------------------ session

function handle(msg, from) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') { startSession(from); return; }
  if (!session || from !== session.from) return;
  switch (msg.type) {
    case 'signal':
      session.link?.onSignal(msg.data);
      break;
    case 'fallback':
      session.link?.close();
      session.link = null;
      showStage();
      break;
    case 'pose':
      if (typeof msg.b === 'string') onPose(Uint8Array.from(atob(msg.b), (c) => c.charCodeAt(0)).buffer);
      break;
    case 'msg':
      onMessage(msg.m);
      break;
    case 'bye':
      endSession('Casting stopped. Start casting again from Avatar Call.');
      break;
  }
}

// A new "hello" always wins: the latest sender to connect takes over the screen.
function startSession(from) {
  endSession(null);
  const webrtc = !!window.RTCPeerConnection;
  session = { from, link: null, meter: null };
  if (webrtc) {
    const link = new PeerLink({
      iceServers: ICE_SERVERS,
      polite: true,
      signal: (data) => send(from, { type: 'signal', data }),
    });
    session.link = link;
    link.addEventListener('channel-open', showStage);
    link.addEventListener('pose', ({ detail }) => onPose(detail));
    link.addEventListener('message', ({ detail }) => onMessage(detail));
    link.addEventListener('track', ({ detail }) => playAudio(detail));
  }
  showIdle('Connecting…');
  send(from, { type: 'ready', webrtc });
}

function endSession(text) {
  if (!session) return;
  session.link?.close();
  session.meter?.disconnect();
  session = null;
  lastSeq = null;
  svgs.reset();
  $('audio').srcObject = null;
  $('sound-btn').hidden = true;
  $('muted').hidden = true;
  avatar.setCustomSvg(null);
  avatar.setPose(neutralPose());
  avatar.setAudioLevel(0);
  notice('');
  if (text) showIdle(text);
}

function onPose(buffer) {
  const pose = decodePose(buffer);
  if (pose && isNewer(pose.seq, lastSeq)) {
    lastSeq = pose.seq;
    avatar.setPose(pose);
  }
}

function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'profile') {
    avatar.setStyle(m.style);
    $('name').textContent = avatar.style.name;
    showStage();
  } else if (m.t === 'status') {
    $('muted').hidden = !m.muted;
  } else if (m.t === 'svg') {
    svgs.push(m);
  }
}

function playAudio(track) {
  const audio = $('audio');
  const stream = new MediaStream([track]);
  audio.srcObject = stream;
  // A preview window sits next to the microphone, so it starts muted to avoid echo.
  audio.muted = !!previewId;
  $('sound-btn').hidden = !previewId;
  audio.play().catch(() => { $('sound-btn').hidden = false; });
  session.meter?.disconnect();
  session.meter = levelMeter(stream);
}

$('sound-btn').addEventListener('click', () => {
  const audio = $('audio');
  audio.muted = false;
  audio.play().then(() => { $('sound-btn').hidden = true; }).catch(() => {});
});

(function meterLoop() {
  avatar.setAudioLevel(session?.meter ? session.meter() : 0);
  requestAnimationFrame(meterLoop);
})();

// ------------------------------------------------------------------ transports

function startPreview(id) {
  document.body.classList.add('preview');
  $('preview-badge').hidden = false;
  document.title = 'Avatar Call TV preview';
  const channel = new BroadcastChannel(`avatar-call-preview-${id}`);
  send = (_to, msg) => channel.postMessage({ to: 'sender', msg: JSON.parse(JSON.stringify(msg)) });
  channel.onmessage = (ev) => { if (ev.data?.to === 'receiver') handle(ev.data.msg, 'preview'); };
  window.addEventListener('pagehide', () => send('preview', { type: 'bye' }));
  showIdle('Waiting for the Avatar Call tab…');
  send('preview', { type: 'loaded' });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function startCast() {
  try {
    await loadScript(CAF_URL);
  } catch (err) {
    showIdle('This page is the TV side of Avatar Call. Open it by casting from the app.');
    console.error(err);
    return;
  }
  const { CastReceiverContext, CastReceiverOptions, system } = cast.framework;
  const context = CastReceiverContext.getInstance();
  context.addCustomMessageListener(CAST_NAMESPACE, (ev) => handle(ev.data, ev.senderId));
  send = (to, msg) => {
    try { context.sendCustomMessage(CAST_NAMESPACE, to, msg); } catch (err) { console.warn('send failed', err); }
  };
  context.addEventListener(system.EventType.SENDER_DISCONNECTED, (ev) => {
    if (session?.from === ev.senderId) endSession('The phone or computer that was casting disconnected.');
    // Close the app if nobody comes back (a sender reloading its page rejoins within seconds).
    setTimeout(() => { if (!context.getSenders().length) context.stop(); }, NO_SENDER_EXIT_MS);
  });
  const options = new CastReceiverOptions();
  options.customNamespaces = { [CAST_NAMESPACE]: system.MessageType.JSON };
  options.disableIdleTimeout = true; // no media is "playing", but we're busy
  options.skipPlayersLoad = true; // we don't use the media player libraries
  options.statusText = 'Avatar Call';
  context.start(options);
}

if (previewId) startPreview(previewId);
else startCast();

// Exposed for automated tests only.
window.__avatarTv = { avatar, get session() { return session; } };

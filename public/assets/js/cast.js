// Cast mode, sender side: stream your avatar and voice to a TV running our
// Custom Web Receiver (receiver.html) via Google Cast, or to a preview window.
//
// The Cast messaging channel only carries the WebRTC handshake. After that,
// voice and avatar motion go straight from this device to the TV over the
// local network, exactly like a call. If the TV can't do WebRTC, avatar motion
// (not voice) falls back to the Cast channel itself.
import { PeerLink } from './peer.js';

export const CAST_NAMESPACE = 'urn:x-cast:io.github.avatarcall';
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const WEBRTC_TIMEOUT_MS = 12000;
const FALLBACK_POSE_INTERVAL_MS = 66; // ~15 fps over the Cast channel

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

// One TV (or preview window). `transport` = { send(msg), close() }; incoming
// messages are passed to onMessage().
class CastTarget extends EventTarget {
  constructor({ kind, label, transport, iceServers, micTrack }) {
    super();
    Object.assign(this, { kind, label, transport, iceServers, micTrack });
    this.link = null;
    this.mode = 'starting'; // 'starting' | 'webrtc' | 'fallback'
    this.lastFallbackPose = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  start() { this.transport.send({ type: 'hello', v: 1 }); }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      this.link?.close();
      this.link = null;
      if (msg.webrtc && window.RTCPeerConnection) this.startWebRtc();
      else this.useFallback('This TV cannot receive voice; only your avatar is shown.');
    } else if (msg.type === 'signal') {
      this.link?.onSignal(msg.data);
    } else if (msg.type === 'bye') {
      this.emit('ended');
    }
  }

  startWebRtc() {
    const link = new PeerLink({
      iceServers: this.iceServers,
      polite: false,
      signal: (data) => this.transport.send({ type: 'signal', data }),
      micTrack: this.micTrack,
    });
    this.link = link;
    link.addEventListener('channel-open', () => {
      if (link !== this.link) return;
      clearTimeout(this.timer);
      this.mode = 'webrtc';
      this.emit('ready');
    });
    link.addEventListener('state', ({ detail }) => link === this.link && this.emit('link-state', detail));
    this.timer = setTimeout(() => {
      if (this.link === link && !link.chatOpen) {
        this.useFallback('Couldn\'t connect directly to the TV, so voice is off. Your avatar still shows.');
      }
    }, WEBRTC_TIMEOUT_MS);
  }

  useFallback(reason) {
    this.link?.close();
    this.link = null;
    this.mode = 'fallback';
    this.transport.send({ type: 'fallback' });
    this.emit('ready', { warning: reason });
  }

  sendPose(bytes) {
    if (this.mode === 'webrtc') this.link?.sendPose(bytes);
    else if (this.mode === 'fallback') {
      const now = performance.now();
      if (now - this.lastFallbackPose < FALLBACK_POSE_INTERVAL_MS) return;
      this.lastFallbackPose = now;
      this.transport.send({ type: 'pose', b: toBase64(bytes) });
    }
  }

  sendMessage(msg) {
    if (this.mode === 'webrtc') return this.link?.sendMessage(msg);
    if (this.mode === 'fallback') { this.transport.send({ type: 'msg', m: msg }); return true; }
    return false;
  }

  setMicTrack(track) {
    this.micTrack = track;
    this.link?.setMicTrack(track);
  }

  close({ notify = true } = {}) {
    clearTimeout(this.timer);
    if (notify) {
      try { this.transport.send({ type: 'bye' }); } catch { /* already gone */ }
    }
    this.link?.close();
    this.link = null;
    this.mode = 'closed';
    this.transport.close();
  }
}

function loadCastSdk() {
  if (window.cast?.framework) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); resolve(!!ok); };
    const timer = setTimeout(() => done(false), 10000);
    window.__onGCastApiAvailable = (available) => done(available);
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.onerror = () => done(false);
    document.head.appendChild(script);
  });
}

export class CastSender extends EventTarget {
  constructor({ appId, iceServers }) {
    super();
    this.appId = appId;
    this.iceServers = iceServers;
    this.micTrack = null;
    this.targets = new Set();
    this.castTarget = null;
    this.castState = 'unavailable';
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Resolves to 'ready', 'no-app-id' or 'unsupported' (not Chrome, or the SDK couldn't load).
  async init() {
    if (!this.appId) return 'no-app-id';
    if (!(await loadCastSdk()) || !window.cast?.framework) return 'unsupported';
    const { CastContext, CastContextEventType, SessionState } = cast.framework;
    const context = CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: this.appId,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    context.addEventListener(CastContextEventType.CAST_STATE_CHANGED, (ev) => {
      this.castState = ev.castState; // NO_DEVICES_AVAILABLE | NOT_CONNECTED | CONNECTING | CONNECTED
      this.emit('cast-state', ev.castState);
    });
    context.addEventListener(CastContextEventType.SESSION_STATE_CHANGED, (ev) => {
      if (ev.sessionState === SessionState.SESSION_STARTED || ev.sessionState === SessionState.SESSION_RESUMED) {
        this.attachSession(context.getCurrentSession());
      } else if (ev.sessionState === SessionState.SESSION_ENDED) {
        this.detachSession();
      }
    });
    this.context = context;
    this.castState = context.getCastState();
    this.emit('cast-state', this.castState);
    const existing = context.getCurrentSession();
    if (existing) this.attachSession(existing);
    return 'ready';
  }

  // Opens Chrome's device picker. Rejects if the user cancels.
  requestSession() { return this.context.requestSession(); }

  stopCasting() { this.context?.endCurrentSession(true); }

  attachSession(session) {
    if (!session) return;
    if (this.castTarget?.session === session) return;
    this.detachSession({ notify: false });
    const listener = (ns, raw) => {
      let msg;
      try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      target.onMessage(msg);
    };
    const transport = {
      send: (msg) => session.sendMessage(CAST_NAMESPACE, msg).catch((err) => console.warn('cast send failed', err)),
      close: () => session.removeMessageListener(CAST_NAMESPACE, listener),
    };
    const target = this.addTarget({ kind: 'tv', label: session.getCastDevice()?.friendlyName || 'TV', transport });
    target.session = session;
    this.castTarget = target;
    session.addMessageListener(CAST_NAMESPACE, listener);
    target.start();
  }

  detachSession({ notify = true } = {}) {
    if (!this.castTarget) return;
    this.removeTarget(this.castTarget, { notify });
    this.castTarget = null;
  }

  // A receiver page in a normal browser window, talking over BroadcastChannel.
  openPreview(receiverUrl) {
    const id = Math.random().toString(36).slice(2, 10);
    const win = window.open(`${receiverUrl}#preview=${id}`, `avatar-tv-${id}`, 'popup,width=960,height=540');
    if (!win) return false;
    const channel = new BroadcastChannel(`avatar-call-preview-${id}`);
    const transport = {
      // JSON round-trip, like the Cast channel (RTCSessionDescription can't be structured-cloned).
      send: (msg) => channel.postMessage({ to: 'receiver', msg: JSON.parse(JSON.stringify(msg)) }),
      close: () => channel.close(),
    };
    const target = this.addTarget({ kind: 'preview', label: 'Preview window', transport });
    channel.onmessage = (ev) => {
      if (ev.data?.to !== 'sender') return;
      if (ev.data.msg?.type === 'loaded') target.start(); // receiver page finished loading
      else target.onMessage(ev.data.msg);
    };
    const poll = setInterval(() => {
      if (win.closed) { clearInterval(poll); this.removeTarget(target, { notify: false }); }
    }, 1000);
    target.addEventListener('ended', () => { clearInterval(poll); this.removeTarget(target, { notify: false }); });
    return true;
  }

  addTarget({ kind, label, transport }) {
    const target = new CastTarget({ kind, label, transport, iceServers: this.iceServers, micTrack: this.micTrack });
    this.targets.add(target);
    target.addEventListener('ready', ({ detail }) => this.emit('target-ready', { target, warning: detail?.warning }));
    target.addEventListener('ended', () => target.kind === 'tv' && this.detachSession({ notify: false }));
    this.emit('targets');
    return target;
  }

  removeTarget(target, opts) {
    if (!this.targets.delete(target)) return;
    target.close(opts);
    this.emit('targets');
  }

  setMicTrack(track) {
    this.micTrack = track;
    for (const t of this.targets) t.setMicTrack(track);
  }

  sendPose(bytes) { for (const t of this.targets) t.sendPose(bytes); }
  sendMessage(msg) { for (const t of this.targets) t.sendMessage(msg); }

  closeAll() {
    for (const t of [...this.targets]) this.removeTarget(t);
    this.castTarget = null;
  }
}

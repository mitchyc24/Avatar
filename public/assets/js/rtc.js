// Calls: WebSocket signaling through our server pairs two browsers in a room,
// then a PeerLink (peer.js) carries voice, chat and avatar motion directly.
import { PeerLink } from './peer.js';

export const randomId = (bytes = 12) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const newRoomId = () => randomId(16);

const FORWARDED = ['track', 'channel-open', 'channel-close', 'message', 'pose', 'route'];

export class Call extends EventTarget {
  constructor({ room, iceServers }) {
    super();
    this.room = room;
    this.iceServers = iceServers;
    this.clientId = randomId(); // per page load; a reload counts as a new participant
    this.ws = null;
    this.link = null;
    this.left = false;
    this.backoff = 500;
    this.micTrack = null;
    this.state = 'idle';
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state) { if (state !== this.state) { this.state = state; this.emit('state', state); } }

  // ------------------------------------------------------------------ signaling

  connect() {
    this.left = false;
    // Relative to the page, so it also works when the app lives under a sub-path.
    const url = new URL(`ws/${encodeURIComponent(this.room)}?client=${this.clientId}`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.hash = '';
    const ws = new WebSocket(url);
    this.ws = ws;
    if (this.state === 'idle') this.setState('connecting');
    ws.onopen = () => { this.backoff = 500; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onSignalingMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.left) return;
      this.ws = null;
      // Signaling dropping doesn't end an established call; just reconnect quietly.
      if (!this.isConnected()) this.setState(this.state === 'full' ? 'full' : 'reconnecting');
      setTimeout(() => !this.left && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  signal(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'signal', data }));
  }

  onSignalingMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        this.selfId = msg.id;
        const other = msg.peers[0];
        if (msg.reconnected && this.link && other === this.peerId) return; // nothing changed
        if (!other) { this.closePeer(); this.setState('waiting'); return; }
        this.createPeer(other);
        break;
      }
      case 'peer-joined':
        this.createPeer(msg.id);
        break;
      case 'peer-left':
        if (msg.id === this.peerId) {
          this.closePeer();
          this.emit('peer-left');
          this.setState('waiting');
        }
        break;
      case 'signal':
        if (!this.link || msg.from !== this.peerId) this.createPeer(msg.from);
        this.link.onSignal(msg.data);
        break;
      case 'full':
        this.setState('full');
        break;
    }
  }

  // ------------------------------------------------------------------ peer connection

  createPeer(peerId) {
    this.closePeer();
    this.peerId = peerId;
    this.setState('connecting');
    // Server ids are stable per participant, so both sides agree who is polite.
    const link = new PeerLink({
      iceServers: this.iceServers,
      polite: this.selfId > peerId,
      signal: (data) => this.signal(data),
      micTrack: this.micTrack,
    });
    this.link = link;
    link.addEventListener('state', ({ detail }) => link === this.link && this.setState(detail));
    for (const type of FORWARDED) {
      link.addEventListener(type, ({ detail }) => link === this.link && this.emit(type, detail));
    }
  }

  closePeer() {
    const link = this.link;
    this.link = null;
    this.peerId = null;
    if (link) {
      link.close();
      this.emit('channel-close');
    }
  }

  isConnected() { return !!this.link?.connected; }

  // ------------------------------------------------------------------ outgoing

  setMicTrack(track) {
    this.micTrack = track;
    this.link?.setMicTrack(track);
  }

  sendMessage(msg) { return !!this.link?.sendMessage(msg); }
  sendPose(bytes) { this.link?.sendPose(bytes); }

  leave() {
    this.left = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'bye' }));
    this.ws?.close();
    this.ws = null;
    this.closePeer();
    this.setState('left');
  }
}

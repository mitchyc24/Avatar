// Peer-to-peer call: WebSocket signaling to our server, then WebRTC carries
// voice (audio track), chat (reliable data channel) and avatar motion
// (unreliable, unordered data channel: a late frame is worse than a lost one).

const CHAT_CHANNEL = { id: 0, label: 'chat', negotiated: true, ordered: true };
const POSE_CHANNEL = { id: 1, label: 'pose', negotiated: true, ordered: false, maxRetransmits: 0 };

const randomId = (bytes = 12) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const newRoomId = () => randomId(16);

export class Call extends EventTarget {
  constructor({ room, iceServers }) {
    super();
    this.room = room;
    this.iceServers = iceServers;
    this.clientId = randomId(); // per page load; a reload counts as a new participant
    this.ws = null;
    this.pc = null;
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
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(this.room)}?client=${this.clientId}`);
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
        if (msg.reconnected && this.pc && other === this.peerId) return; // nothing changed
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
        if (!this.pc || msg.from !== this.peerId) this.createPeer(msg.from);
        this.signalChain = (this.signalChain || Promise.resolve())
          .then(() => this.onSignal(msg.data))
          .catch((err) => console.warn('signal handling failed', err));
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
    // Exactly one side must be "polite" (yields on offer collisions). Server ids are stable per participant.
    this.polite = this.selfId > peerId;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.signalChain = Promise.resolve();
    this.setState('connecting');

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    if (!this.polite) {
      // The impolite side lays out the session: one two-way audio line plus data.
      this.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.audio.sender.replaceTrack(this.micTrack).catch(() => {});
      this.openChannels();
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.signal({ candidate });
    pc.ontrack = (ev) => this.emit('track', ev.track);
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(this.restartTimer);
        this.setState('connected');
        this.reportRoute();
      } else if (s === 'failed') {
        this.setState('reconnecting');
        this.restartIce();
      } else if (s === 'disconnected') {
        this.setState('reconnecting');
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => pc === this.pc && pc.connectionState !== 'connected' && this.restartIce(), 4000);
      }
    };
  }

  restartIce() {
    if (this.pc && !this.polite) this.pc.restartIce();
  }

  async onSignal(data) {
    const pc = this.pc;
    if (!pc || !data) return;
    if (data.description) {
      const description = data.description;
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        if (this.polite) this.adoptRemoteLayout();
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn('bad ICE candidate', err);
      }
    }
  }

  // Polite side: reuse the audio line and data channels the other side offered.
  adoptRemoteLayout() {
    if (!this.audio) {
      this.audio = this.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio') || null;
      if (this.audio) {
        this.audio.direction = 'sendrecv';
        this.audio.sender.replaceTrack(this.micTrack).catch(() => {});
      }
    }
    if (!this.chat) this.openChannels();
  }

  openChannels() {
    const pc = this.pc;
    this.chat = pc.createDataChannel(CHAT_CHANNEL.label, CHAT_CHANNEL);
    this.pose = pc.createDataChannel(POSE_CHANNEL.label, POSE_CHANNEL);
    this.pose.binaryType = 'arraybuffer';
    const chat = this.chat, pose = this.pose;
    chat.onopen = () => chat === this.chat && this.emit('channel-open');
    chat.onclose = () => chat === this.chat && this.emit('channel-close');
    chat.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === 'object') this.emit('message', msg);
    };
    pose.onmessage = (ev) => ev.data instanceof ArrayBuffer && this.emit('pose', ev.data);
  }

  async reportRoute() {
    try {
      const stats = await this.pc.getStats();
      let pair;
      stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      this.emit('route', { relayed, rtt: pair?.currentRoundTripTime });
    } catch { /* stats are informational only */ }
  }

  closePeer() {
    clearTimeout(this.restartTimer);
    if (this.chat) { this.chat.onopen = this.chat.onclose = this.chat.onmessage = null; }
    if (this.pose) this.pose.onmessage = null;
    if (this.pc) {
      this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    const hadChat = !!this.chat;
    this.pc = this.chat = this.pose = this.audio = null;
    this.peerId = null;
    if (hadChat) this.emit('channel-close');
  }

  isConnected() { return this.pc?.connectionState === 'connected'; }

  // ------------------------------------------------------------------ outgoing

  setMicTrack(track) {
    this.micTrack = track;
    this.audio?.sender.replaceTrack(track).catch((err) => console.warn('replaceTrack failed', err));
  }

  sendMessage(msg) {
    if (this.chat?.readyState !== 'open') return false;
    this.chat.send(JSON.stringify(msg));
    return true;
  }

  sendPose(bytes) {
    const ch = this.pose;
    if (ch?.readyState === 'open' && ch.bufferedAmount < 16 * 1024) ch.send(bytes);
  }

  leave() {
    this.left = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'bye' }));
    this.ws?.close();
    this.ws = null;
    this.closePeer();
    this.setState('left');
  }
}

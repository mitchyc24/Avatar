// One WebRTC connection to one other device, independent of how signaling
// messages travel (our WebSocket server for calls, the Cast channel for TVs).
//
// Carries voice (one audio line), a reliable ordered "chat" channel for JSON
// messages and an unreliable unordered "pose" channel for avatar motion
// (a late frame is worse than a lost one). Uses the "perfect negotiation"
// pattern: exactly one side is polite and yields when offers collide.

const CHAT_CHANNEL = { id: 0, label: 'chat', negotiated: true, ordered: true };
const POSE_CHANNEL = { id: 1, label: 'pose', negotiated: true, ordered: false, maxRetransmits: 0 };

export class PeerLink extends EventTarget {
  // signal(data) must deliver `data` to the other side's onSignal().
  constructor({ iceServers, polite, signal, micTrack = null }) {
    super();
    this.polite = polite;
    this.signal = signal;
    this.micTrack = micTrack;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.queue = Promise.resolve();
    this.chat = this.pose = this.audio = null;

    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    if (!polite) {
      // The impolite side lays out the session: one two-way audio line plus data.
      this.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.audio.sender.replaceTrack(micTrack).catch(() => {});
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
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(this.restartTimer);
        this.emit('state', 'connected');
        this.reportRoute();
      } else if (s === 'failed') {
        this.emit('state', 'reconnecting');
        this.restartIce();
      } else if (s === 'disconnected') {
        this.emit('state', 'reconnecting');
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => pc.connectionState !== 'connected' && this.restartIce(), 4000);
      }
    };
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get connected() { return this.pc?.connectionState === 'connected'; }
  get chatOpen() { return this.chat?.readyState === 'open'; }

  restartIce() {
    if (this.pc && !this.polite) this.pc.restartIce();
  }

  // Signals must be applied in order, so they are queued.
  onSignal(data) {
    this.queue = this.queue.then(() => this.applySignal(data)).catch((err) => console.warn('signal handling failed', err));
    return this.queue;
  }

  async applySignal(data) {
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
    const chat = this.pc.createDataChannel(CHAT_CHANNEL.label, CHAT_CHANNEL);
    const pose = this.pc.createDataChannel(POSE_CHANNEL.label, POSE_CHANNEL);
    pose.binaryType = 'arraybuffer';
    this.chat = chat;
    this.pose = pose;
    chat.onopen = () => this.emit('channel-open');
    chat.onclose = () => this.emit('channel-close');
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

  setMicTrack(track) {
    this.micTrack = track;
    this.audio?.sender.replaceTrack(track).catch((err) => console.warn('replaceTrack failed', err));
  }

  sendMessage(msg) {
    if (!this.chatOpen) return false;
    this.chat.send(JSON.stringify(msg));
    return true;
  }

  sendPose(bytes) {
    const ch = this.pose;
    if (ch?.readyState === 'open' && ch.bufferedAmount < 16 * 1024) ch.send(bytes);
  }

  close() {
    clearTimeout(this.restartTimer);
    const hadChat = !!this.chat;
    if (this.chat) this.chat.onopen = this.chat.onclose = this.chat.onmessage = null;
    if (this.pose) this.pose.onmessage = null;
    if (this.pc) {
      this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = this.chat = this.pose = this.audio = null;
    if (hadChat) this.emit('channel-close');
  }
}

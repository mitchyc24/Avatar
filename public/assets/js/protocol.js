// Wire format for avatar motion: one small binary packet per tracked frame.
// Each field is quantized to a byte; signed fields span -1..1, unsigned 0..1.
// Packet = [seq hi, seq lo, flags, ...fields]  (24 bytes at ~25 fps ≈ 0.6 KB/s)
//
// All left/right values are in the *unmirrored camera image* frame, i.e. what
// someone facing you would see. The self-preview mirrors the whole avatar.

export const FIELDS = [
  ['yaw', 's'],        // + = face turned toward image right
  ['pitch', 's'],      // + = looking down
  ['roll', 's'],       // + = clockwise on screen, in units of 45°
  ['x', 's'],          // head position in frame
  ['y', 's'],
  ['scale', 's'],      // + = leaning in
  ['blinkL', 'u'],     // eye on the image-left side
  ['blinkR', 'u'],
  ['gazeX', 's'],
  ['gazeY', 's'],      // + = looking up
  ['jaw', 'u'],
  ['smile', 'u'],
  ['frown', 'u'],
  ['funnel', 'u'],
  ['pucker', 'u'],
  ['browUp', 'u'],
  ['browDown', 'u'],
  ['browOuterUp', 'u'],
  ['cheekPuff', 'u'],
  ['squint', 'u'],
  ['wide', 'u'],
];

export const FLAG_TRACKING = 1;

const HEADER = 3;
export const PACKET_SIZE = HEADER + FIELDS.length;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function neutralPose() {
  const pose = { tracking: false };
  for (const [name] of FIELDS) pose[name] = 0;
  return pose;
}

export function encodePose(pose, seq) {
  const out = new Uint8Array(PACKET_SIZE);
  out[0] = (seq >> 8) & 0xff;
  out[1] = seq & 0xff;
  out[2] = pose.tracking ? FLAG_TRACKING : 0;
  FIELDS.forEach(([name, kind], i) => {
    const v = Number(pose[name]) || 0;
    out[HEADER + i] = kind === 's'
      ? Math.round((clamp(v, -1, 1) + 1) * 127.5)
      : Math.round(clamp(v, 0, 1) * 255);
  });
  return out;
}

export function decodePose(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== PACKET_SIZE) return null;
  const pose = { seq: (bytes[0] << 8) | bytes[1], tracking: !!(bytes[2] & FLAG_TRACKING) };
  FIELDS.forEach(([name, kind], i) => {
    const b = bytes[HEADER + i];
    pose[name] = kind === 's' ? b / 127.5 - 1 : b / 255;
  });
  return pose;
}

// True if `seq` is newer than `last` on a 16-bit wrapping counter.
export function isNewer(seq, last) {
  if (last == null) return true;
  const diff = (seq - last + 0x10000) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}

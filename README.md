# Avatar Call

Peer-to-peer voice and text chat where each person appears as a live SVG cartoon avatar
driven by their webcam. You host it on your own computer. Your friend just opens a link:
no install, no account.

## Quick start

```bash
./avatar --share
```

1. Your browser opens to `http://localhost:8787`. Click **Start a call**.
2. After a few seconds the page shows an **invite link** (`https://….trycloudflare.com/r/…`). Send it to your friend.
3. Click **Turn on camera & microphone**, adjust your avatar, then **Join call**.
4. Your friend opens the link, allows camera and mic, and joins.

The first run downloads the face-tracking files (~27 MB) and `cloudflared`, all pinned and checksum-verified.
Stop the server with `Ctrl+C`. That also closes the public link.

| Command | What you get |
| --- | --- |
| `./avatar` | Local only, for trying it out on this computer |
| `./avatar --share` | Plus a public HTTPS link through a free Cloudflare quick tunnel (new random address each run) |
| `./avatar --lan` | Plus HTTPS on your home network at `https://<this-pc>:8788` (self-signed, so browsers show a warning once) |
| `--port N`, `--no-open`, `-v` | Change the port, don't open a browser, verbose logs |

## How it works

```
 your browser                                                friend's browser
 ┌───────────────────────────┐                             ┌───────────────────────────┐
 │ webcam → MediaPipe face   │   avatar pose ~25×/s (24 B) │ draws YOUR avatar         │
 │ tracking → pose numbers ──┼────────────────────────────►│ from the pose numbers     │
 │ microphone ───────────────┼──── voice (WebRTC audio) ──►│ speaker                   │
 │ chat box ─────────────────┼──── text (data channel) ───►│ chat log                  │
 └───────────▲───────────────┘      (and the reverse)      └──────────────▲────────────┘
             │      WebRTC peer-to-peer, encrypted (DTLS/SRTP)            │
             └──────── handshake only, via this server (WebSocket) ───────┘
```

- **Camera video never leaves the device.** Each browser runs face tracking locally and sends only about 20 numbers per frame: head turn/tilt/position, blinks, gaze, jaw, smile, brows and so on.
- **Peer-to-peer.** After the handshake, voice, chat and avatar motion go directly between the two browsers, encrypted end to end. The server never sees them.
- **Two people per call.** A third visitor to the link is told the call is full.
- **Bring your own avatar.** Upload or paste any SVG whose parts are named by the
  [custom avatar schema](docs/custom-avatars.md) (`head`, `eye-left`, `mouth-open`, …) and your face animates it.
  The lobby has a **Copy AI prompt** button: give it to ChatGPT with a photo of yourself and it draws a matching SVG.
  Custom SVGs are cleaned against a strict allowlist on both ends, since they're sent to the other person.
- **Without a camera** the avatar idles and its mouth follows your voice. **Without a mic** you can still chat.
- **Accessibility.** Full keyboard support, labelled controls, a screen-reader-announced chat log and status, `prefers-reduced-motion`, and light/dark themes.

### Browser support

Current Chrome, Edge, Firefox and Safari on desktop, Android and iOS/iPadOS. Camera and mic need HTTPS,
which `--share` and `--lan` provide (`localhost` also works). Face tracking uses the GPU where available
and falls back to the CPU on older devices, dropping its frame rate if the device is slow.

### When a call won't connect

Peer-to-peer needs both networks to allow a direct path. That works on most home and mobile networks using
the public STUN servers. Some strict corporate, campus or carrier networks block it. For those you need a
**TURN relay**. Copy `config.example.json` to `config.json` and fill in a TURN server, either your own
[coturn](https://github.com/coturn/coturn) or a hosted service. The relay only forwards encrypted traffic.

## Project layout

```
avatar               launcher script
server.py            aiohttp: static files, signaling WebSocket (/ws/<room>), /api/config, tunnel, LAN HTTPS
setup.sh             downloads pinned MediaPipe + cloudflared into public/vendor and bin/
public/index.html    the whole UI (landing, lobby, call)
public/assets/
  app.css
  js/app.js          UI flow: media permissions, lobby, call screen, chat
  js/tracker.js      MediaPipe Face Landmarker → pose parameters (calibration, smoothing)
  js/protocol.js     24-byte binary pose packet
  js/avatar.js       SVG avatar renderer and customisation options
  js/custom-avatar.js  custom SVG avatars: sanitizer, part finder, animation rig
  avatar-template.svg  example custom avatar following the schema
  avatar-prompt.txt    AI prompt that turns a photo into a schema-compliant SVG
docs/custom-avatars.md the custom avatar schema
  js/rtc.js          WebSocket signaling + WebRTC "perfect negotiation"
tests/e2e.py         two headless Chromes with fake camera/mic run a full call
```

## Tests

```bash
python3 tests/e2e.py --keep-screens /tmp/avatar-screens
```

This starts the server and two headless Chrome instances that use a face photo as a fake camera. It checks
local face tracking, the peer-to-peer connection, avatar motion (including the correct direction of a head
tilt), custom SVG avatars (a hostile SVG is defused, a template upload, a multi-chunk paste reaching the other
side intact and tilting correctly), chat both ways (and that it can't inject HTML), audio both ways, mute status, leave and rejoin, the
two-person limit, and that there are no JavaScript errors.

Requirements: Python 3.10+ with `aiohttp`, `openssl` (for `--lan`), and Google Chrome plus `ffmpeg` for the tests.

# Avatar Call

Voice and text chat where each person appears as a live SVG cartoon avatar driven by their webcam, plus a
**Cast mode** that puts your animated avatar and voice on a TV. Calls are peer-to-peer and hosted on your own
computer. Your friend just opens a link: no install, no account.

- **Camera video never leaves your device.** Face tracking runs in your browser, and only about 20 numbers per frame (head pose, blinks, gaze, mouth, brows) are sent.
- **Peer-to-peer.** Voice, chat and avatar motion go directly between devices over encrypted WebRTC.
- **Bring your own avatar.** Use any SVG that follows the [custom avatar schema](docs/custom-avatars.md). The app includes an AI prompt that turns a photo of you into one.
- **Cast to a TV.** Show your avatar full screen on a Chromecast or Google TV and play your voice there ([docs/casting.md](docs/casting.md)).

## Quick start: calls

```bash
./avatar --share
```

1. Your browser opens to `http://localhost:8787`. Click **Start a call**.
2. After a few seconds the page shows an **invite link** (`https://….trycloudflare.com/#room=…`). Send it to your friend.
3. Click **Turn on camera & microphone**, adjust your avatar, then **Join call**.
4. Your friend opens the link, allows camera and mic, and joins.

The first run downloads the face-tracking files (~27 MB) and `cloudflared`, all pinned and checksum-verified.
`Ctrl+C` stops the server and closes the public link.

| Command | What you get |
| --- | --- |
| `./avatar` | Local only, for trying it out on this computer |
| `./avatar --share` | Plus a public HTTPS link through a free Cloudflare quick tunnel (new random address each run) |
| `./avatar --lan` | Plus HTTPS on your home network at `https://<this-pc>:8788` (self-signed, so browsers show a warning once) |
| `--port N`, `--no-open`, `-v` | Change the port, don't open a browser, verbose logs |

## Quick start: Cast mode

Cast mode needs no server. It runs from the GitHub Pages site or from your local one.

1. One-time setup: publish to GitHub Pages, register a Cast app pointing to `…/receiver.html`, and put its ID in `public/cast-config.json`. The step-by-step guide is [docs/casting.md](docs/casting.md).
2. In Chrome, open the app, choose **Cast to a TV**, turn on camera and mic, and click **Cast to TV**.

**Preview TV view in a window** shows exactly what the TV shows, with no TV or setup needed.

## How it works

```
 your browser                                                friend's browser / TV
 ┌───────────────────────────┐                             ┌───────────────────────────┐
 │ webcam → MediaPipe face   │   avatar pose ~25×/s (24 B) │ draws YOUR avatar         │
 │ tracking → pose numbers ──┼────────────────────────────►│ from the pose numbers     │
 │ microphone ───────────────┼──── voice (WebRTC audio) ──►│ speaker                   │
 │ chat box ─────────────────┼──── text (data channel) ───►│ chat log                  │
 └───────────▲───────────────┘                             └──────────────▲────────────┘
             │      WebRTC peer-to-peer, encrypted (DTLS/SRTP)            │
             └── handshake only: our server (calls) or the Cast channel (TV) ┘
```

- **Calls** pair two browsers through the small Python server (`server.py`), using a WebSocket handshake. After that, nothing goes through the server. Two people per call.
- **Cast mode** uses Google Cast only to launch `receiver.html` on the TV and exchange the handshake. Voice and motion then go directly over your home network.
- **Custom SVG avatars** are cleaned against a strict allowlist on both ends, because they're sent to the other device.
- **Without a camera** the avatar idles and its mouth follows your voice. **Without a mic** you can still chat.
- **Accessibility.** Full keyboard support, labelled controls, a screen-reader-announced chat log and status, `prefers-reduced-motion`, and light/dark themes.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes `public/` on every push to `main` (set **Settings → Pages → Source** to
**GitHub Actions**). The Pages site gives you:
- Cast mode, fully working, with no server.
- `receiver.html`, the URL your Cast application points to.
- Call links don't work there. Calls need the signaling server, so the landing page explains that and points to `./avatar --share`.

All paths are relative and routes live in the URL fragment (`#room=…`, `#cast`), so the app works under any sub-path.

### Browser support

Calls work in current Chrome, Edge, Firefox and Safari on desktop, Android and iOS/iPadOS. Casting needs Chrome
on a computer or Android. Camera and mic need HTTPS, which `--share`, `--lan` and GitHub Pages provide
(`localhost` also works).

### When a call won't connect

Peer-to-peer needs both networks to allow a direct path. That works on most home and mobile networks using
the public STUN servers. Some strict corporate, campus or carrier networks block it. For those you need a
**TURN relay**. Copy `config.example.json` to `config.json` and fill in a TURN server, either your own
[coturn](https://github.com/coturn/coturn) or a hosted service. The relay only forwards encrypted traffic.

## Project layout

```
avatar                   launcher script
server.py                aiohttp: static files, signaling WebSocket (/ws/<room>), /api/config, tunnel, LAN HTTPS
setup.sh                 downloads pinned MediaPipe (+ cloudflared with --tunnel)
.github/workflows/       GitHub Pages deployment
public/index.html        the app UI: landing, lobby, call, Cast mode
public/receiver.html     the Google Cast receiver (TV side)
public/cast-config.json  your Cast application ID
public/assets/
  js/app.js              UI flow: media permissions, lobby, call screen, chat, Cast screen
  js/tracker.js          MediaPipe Face Landmarker → pose parameters (calibration, smoothing)
  js/protocol.js         24-byte binary pose packet
  js/avatar.js           built-in SVG avatar renderer and customisation options
  js/custom-avatar.js    custom SVG avatars: sanitizer, animation rig, chunked transfer
  js/peer.js             one WebRTC link: voice + chat/pose data channels, perfect negotiation
  js/rtc.js              calls: WebSocket signaling through server.py
  js/cast.js             Cast mode sender: Cast SDK session, preview window, per-TV links
  js/receiver.js         Cast mode receiver
  js/audio.js            voice level metering
  avatar-template.svg    example custom avatar following the schema
  avatar-prompt.txt      AI prompt that turns a photo into a schema-compliant SVG
docs/custom-avatars.md   the custom avatar schema
docs/casting.md          Cast setup, usage and protocol
tests/e2e.py             end-to-end tests in headless Chrome
```

## Tests

```bash
python3 tests/e2e.py --keep-screens /tmp/avatar-screens
```

The tests run headless Chrome instances that use a face photo as a fake camera. **Calls:**
- local face tracking and the peer-to-peer connection
- avatar motion, including the correct direction of a head tilt
- custom SVG avatars: a hostile SVG is defused, a template uploads, and a multi-chunk paste reaches the other side intact
- chat both ways, with no HTML injection
- audio both ways, mute status, leave and rejoin, and the two-person limit

**Cast mode,** served as static files under a sub-path like GitHub Pages:
- the TV preview connects
- head motion, voice, name and custom avatar all arrive
- muting and stopping work

Both suites also check that there are no JavaScript errors.

Requirements: Python 3.10+ with `aiohttp`, `openssl` (for `--lan`), and Google Chrome plus `ffmpeg` for the tests.

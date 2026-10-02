# Cast mode: your avatar and voice on a TV

Cast mode shows your animated avatar full screen on a Chromecast or Google TV and plays your voice through the
TV. Face tracking still runs on your computer or phone. The TV only draws the avatar and plays the sound.

```
 Chrome (computer / Android)                         TV (Chromecast / Google TV)
 ┌──────────────────────────────┐   Cast channel:    ┌──────────────────────────────┐
 │ webcam → face tracking       │── handshake only ─►│ receiver.html (GitHub Pages) │
 │ avatar pose ──────────────── │══ WebRTC, LAN ════►│ draws the avatar             │
 │ microphone ───────────────── │══ WebRTC, LAN ════►│ plays your voice             │
 └──────────────────────────────┘                    └──────────────────────────────┘
```

Voice and motion go directly over your home network. If the TV can't make a WebRTC connection, the avatar's
motion falls back to the Cast channel (about 15 fps) and voice is turned off. The sender page tells you when that
happens.

## One-time setup

### 1. Host the receiver on GitHub Pages

The repository's workflow (`.github/workflows/pages.yml`) publishes `public/` to GitHub Pages on every push to
`main`. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. The receiver is then at:

```
https://<your-user>.github.io/<repo>/receiver.html
```

Open that URL in a normal browser as a quick check. It should show the dark Avatar Call "Ready" screen. Outside a
Cast device it can't do anything else, and the console shows the Cast SDK failing to reach `localhost:8008`. That's expected.

### 2. Register a Cast application

1. Go to the [Google Cast SDK Developer Console](https://cast.google.com/publish). Registration has a one-time $5 fee.
2. **Add new application → Custom Receiver.**
3. Name it (e.g. *Avatar Call*) and set **Receiver Application URL** to the `receiver.html` URL above.
4. Save. Copy the **Application ID** (8 characters, e.g. `A1B2C3D4`).

### 3. Tell the app your Application ID

Edit `public/cast-config.json`:

```json
{ "receiverAppId": "A1B2C3D4" }
```

Commit and push. Pages redeploys within a minute or two.

### 4. Register your TV for testing

New applications are **unpublished**, which means they only launch on devices registered to your developer
account:

1. Find the device's serial number: in the Google Home app, open the device's **Settings → Device information**, or look on the device or its box.
2. In the Developer Console, open **Cast Receiver Devices → Add new device**, then enter the serial number and a description.
3. Wait about 15 minutes, then **restart the Chromecast**. It only picks up the registration after a reboot.

When everything works, you can **Publish** the application in the console so it launches on any Cast device.
Until then, only your registered devices can run it.

## Using it

1. Open the app in Chrome on a computer or Android phone. Either the GitHub Pages site (`https://<your-user>.github.io/<repo>/`) or your self-hosted server works.
2. Choose **Cast to a TV**, then **Turn on camera & microphone**.
3. Click **Cast to TV** and pick your device. Your avatar appears on the TV within a few seconds.
4. **Send my voice to the TV** turns your voice on the TV on and off. Use headphones, or keep the microphone away from the TV, or its speakers will feed back into the mic.
5. **Preview TV view in a window** opens the exact TV page in a browser window. Use it to check things without a TV, or to share the window in OBS or another video app. It starts muted for the same echo reason.

Another sender that starts casting to the same TV takes over the screen. The receiver closes itself 30 seconds
after the last sender disconnects.

## Requirements and limits

- **Sender:** Google Chrome on Windows, macOS, Linux, ChromeOS or Android. Chrome's Cast support isn't available in Firefox, Safari or any iOS browser.
- **Receiver:** Chromecast (2nd generation or later recommended), Chromecast with Google TV, or a TV with Chromecast built in.
- **Network:** both devices on the same network, and the network must allow device-to-device traffic. Guest networks and "AP isolation" block it.
- The TV redraws at up to 30 fps to stay smooth on low-power hardware.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Casting isn't set up yet" | `public/cast-config.json` has no `receiverAppId`. |
| "Casting needs Google Chrome" | You're not in Chrome, or Google's Cast script couldn't load (ad blockers sometimes block `gstatic.com`). |
| Your TV isn't in the device list | The TV is on a different network, or the network isolates devices. |
| The TV shows a Cast error or a blank screen | The device isn't registered yet, or wasn't restarted after registering. Also check that the Receiver URL in the console exactly matches the Pages URL (https, including `/receiver.html`). |
| "avatar only, no voice" | The direct connection to the TV failed (network isolation, or an older Chromecast without WebRTC). |
| Echo or howling | The microphone is hearing the TV. Use headphones, or untick **Send my voice to the TV**. |

To debug the receiver, register the device as above, then open `chrome://inspect` in Chrome on a computer on the
same network. The running receiver appears there, with its console.

## Protocol (for developers)

Namespace `urn:x-cast:io.github.avatarcall`, JSON messages:

| Direction | Message | Meaning |
| --- | --- | --- |
| sender → TV | `{type:"hello", v:1}` | Start (or take over) a session |
| TV → sender | `{type:"ready", webrtc:bool}` | TV is ready; whether it supports WebRTC |
| both | `{type:"signal", data}` | WebRTC offer/answer/ICE candidates (the sender is the impolite peer) |
| sender → TV | `{type:"fallback"}` | No WebRTC: poses and messages will come over the Cast channel |
| sender → TV | `{type:"pose", b}` | Fallback only: base64 pose packet (see `protocol.js`) |
| sender → TV | `{type:"msg", m}` | Fallback only: a data-channel message (`profile`, `status`, `svg` chunks) |
| sender → TV | `{type:"bye"}` | Stop showing this sender |

Once WebRTC is up, the TV gets the same data-channel messages as a call peer (`profile`, `status`, `svg` chunks),
pose packets on the unreliable channel, and the microphone as an audio track. The preview window uses the same
messages over a `BroadcastChannel` instead of the Cast channel.

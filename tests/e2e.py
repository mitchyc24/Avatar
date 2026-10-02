#!/usr/bin/env python3
"""End-to-end test: two headless Chrome instances join the same room with fake
cameras (a face photo) and fake microphones, then we check that they connect
peer-to-peer, animate each other's avatars, exchange chat and hear audio.

Usage: python3 tests/e2e.py [--keep-screens DIR]
Needs google-chrome and ffmpeg. Fixtures are generated into tests/fixtures/.
"""

import argparse
import asyncio
import itertools
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
PORTRAIT_URL = "https://storage.googleapis.com/mediapipe-assets/portrait.jpg"
SERVER_PORT = 8799
TILT_RAD = 0.3  # clockwise tilt baked into person A's fake camera

CHROME = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")


def make_fixtures():
    FIXTURES.mkdir(exist_ok=True)
    portrait = FIXTURES / "portrait.jpg"
    if not portrait.exists():
        urllib.request.urlretrieve(PORTRAIT_URL, portrait)
    clips = {
        # Still, tilted clockwise: lets us check the direction of head roll.
        "tilt.y4m": f"crop=560:420:130:0,scale=640:480,rotate={TILT_RAD}:fillcolor=gray",
        # Gently rocking head, so the avatar visibly moves.
        "rock.y4m": "crop=560:420:130:0,scale=640:480,rotate='0.3*sin(2*PI*t/4)':fillcolor=gray",
    }
    for name, vf in clips.items():
        out = FIXTURES / name
        if not out.exists():
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", str(portrait),
                            "-t", "4", "-r", "15", "-vf", vf, "-pix_fmt", "yuv420p", str(out)], check=True)
    return FIXTURES / "tilt.y4m", FIXTURES / "rock.y4m"


class Page:
    """Minimal Chrome DevTools Protocol client for one tab."""

    def __init__(self, name, port, video):
        self.name, self.port, self.video = name, port, video
        self.ids = itertools.count(1)
        self.pending = {}
        self.errors = []
        self.logs = []
        self.proc = None

    async def launch(self, session):
        self.profile = tempfile.mkdtemp(prefix=f"avatar-e2e-{self.name}-")
        self.proc = subprocess.Popen([
            CHROME, "--headless=new", f"--remote-debugging-port={self.port}", f"--user-data-dir={self.profile}",
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-video-capture={self.video}",
            "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check",
            "--enable-unsafe-swiftshader", "--window-size=1280,860", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                async with session.get(f"http://127.0.0.1:{self.port}/json/list") as r:
                    targets = await r.json()
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                await asyncio.sleep(0.1)
        else:
            raise RuntimeError(f"{self.name}: Chrome did not start")
        self.ws = await session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=0)
        self.reader = asyncio.create_task(self.read())
        await self.cmd("Runtime.enable")
        await self.cmd("Page.enable")

    async def attach_tab(self, session, url_part, name):
        """Connect to another tab of this browser (e.g. a popup the app opened)."""
        for _ in range(100):
            async with session.get(f"http://127.0.0.1:{self.port}/json/list") as r:
                targets = await r.json()
            found = [t for t in targets if t["type"] == "page" and url_part in t["url"]]
            if found:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(f"{name}: no tab with {url_part!r}")
        tab = Page(name, self.port, None)
        tab.ws = await session.ws_connect(found[0]["webSocketDebuggerUrl"], max_msg_size=0)
        tab.reader = asyncio.create_task(tab.read())
        await tab.cmd("Runtime.enable")
        await tab.cmd("Page.enable")
        return tab

    async def read(self):
        async for msg in self.ws:
            data = json.loads(msg.data)
            if "id" in data and data["id"] in self.pending:
                self.pending.pop(data["id"]).set_result(data)
            elif data.get("method") == "Runtime.exceptionThrown":
                d = data["params"]["exceptionDetails"]
                self.errors.append(d.get("exception", {}).get("description") or d.get("text"))
            elif data.get("method") == "Runtime.consoleAPICalled":
                p = data["params"]
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in p["args"])
                self.logs.append(f"[{p['type']}] {text}")
                if p["type"] == "error":
                    self.errors.append(text)

    async def cmd(self, method, **params):
        i = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[i] = fut
        await self.ws.send_json({"id": i, "method": method, "params": params})
        res = await asyncio.wait_for(fut, 60)
        if "error" in res:
            raise RuntimeError(f"{self.name}: {method} failed: {res['error']}")
        return res["result"]

    async def js(self, expr, gesture=False):
        res = await self.cmd("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True,
                             userGesture=gesture)
        if "exceptionDetails" in res:
            raise RuntimeError(f"{self.name}: JS error in {expr!r}: {res['exceptionDetails']}")
        return res["result"].get("value")

    async def wait_for(self, expr, timeout=30, what=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if await self.js(expr):
                return
            await asyncio.sleep(0.25)
        raise AssertionError(f"{self.name}: timed out waiting for {what or expr}")

    async def screenshot(self, path):
        import base64
        res = await self.cmd("Page.captureScreenshot", format="png")
        Path(path).write_bytes(base64.b64decode(res["data"]))

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass
        if not self.proc:
            return
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


passed = []


def check(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        raise AssertionError(label)
    passed.append(label)


async def run(screens):
    tilt, rock = make_fixtures()
    server = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(SERVER_PORT), "--no-open"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    pages = []
    try:
        async with aiohttp.ClientSession() as session:
            for _ in range(50):
                try:
                    async with session.get(f"http://127.0.0.1:{SERVER_PORT}/api/config") as r:
                        if r.status == 200:
                            break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.1)

            a, b = Page("A", 9331, tilt), Page("B", 9332, rock)
            pages = [a, b]
            await asyncio.gather(a.launch(session), b.launch(session))
            room = "e2e" + secrets.token_urlsafe(12)
            url = f"http://localhost:{SERVER_PORT}/#room={room}"
            print(f"Room: {url}")

            for p, name in ((a, "Alice"), (b, "Bob")):
                await p.cmd("Page.navigate", url=url)
                await p.wait_for("document.readyState === 'complete' && !!window.__avatarCall", what="app load")
                await p.js(f"""(() => {{ const i = document.getElementById('name-input');
                    i.value = {json.dumps(name)}; i.dispatchEvent(new Event('input', {{bubbles: true}})); }})()""")
                await p.js("document.getElementById('media-btn').click()")

            for p in pages:
                await p.wait_for("!!window.__avatarCall.state.tracker && window.__avatarCall.state.tracker.running",
                                 timeout=90, what="face tracker to start")
                delegate = await p.js("window.__avatarCall.state.tracker.delegate")
                await p.wait_for("window.__avatarCall.selfAvatar.target.tracking === true", timeout=30,
                                 what="own face to be tracked")
                check(True, f"{p.name}: face tracked locally ({delegate} delegate)")
                check(await p.js("!!window.__avatarCall.state.micTrack"), f"{p.name}: microphone captured")


            # --- Custom SVG avatars -------------------------------------------------
            # 1. A hostile SVG is defused by the sanitizer.
            evil = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">'
                    '<style>body{display:none} .skin{fill:#c96}</style><script>alert(2)</script>'
                    '<g id="Head"><rect class="skin" width="5" height="5" onclick="x()"/>'
                    '<image href="https://evil.example/track.png"/><use xlink:href="https://evil.example/a.svg#x"/>'
                    '<path d="M0 0" fill="url(https://evil.example/x)" style="fill:url(http://evil.example/y);stroke:red"/>'
                    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'
                    '<a href="javascript:alert(3)"><circle r="1"/></a><animate attributeName="href" to="javascript:alert(4)"/>'
                    '</g></svg>')
            res = await a.js(f"import('/assets/js/custom-avatar.js').then(m => m.sanitizeSvg({json.dumps(evil)}))")
            out = res.get("svg", "")
            bad = [t for t in ("script", "onload", "onclick", "evil.example", "javascript", "foreignObject", "<style",
                               "body", "animate", "alert") if t in out]
            check(res["ok"] and not bad, f"hostile SVG is defused (leftovers: {bad or 'none'})")
            check("fill:#c96" in out and "stroke:red" in out and "<circle" in out and res["parts"] == ["head"],
                  "sanitizer keeps the harmless drawing, inlines simple CSS and finds parts case-insensitively")

            # 2. A uploads the template through the real file picker.
            doc = await a.cmd("DOM.getDocument")
            node = await a.cmd("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector="#svg-file")
            await a.cmd("DOM.setFileInputFiles", nodeId=node["nodeId"], files=[str(ROOT / "public/assets/avatar-template.svg")])
            await a.wait_for("document.getElementById('svg-report').textContent.includes('Custom avatar loaded')", what="upload report")
            parts = await a.js("[...document.querySelectorAll('#svg-report code')].map(c => c.textContent)")
            check(len(parts) == 18 and await a.js("!!window.__avatarCall.selfAvatar.custom"),
                  f"A: template upload accepted with all {len(parts)} parts and shown in the preview")

            # 3. B pastes a big SVG (forces multi-chunk transfer), wrapped in a markdown fence like an AI chat would.
            template = (ROOT / "public/assets/avatar-template.svg").read_text()
            filler = "".join(f'<circle cx="{(i * 37) % 400}" cy="{(i * 53) % 120}" r="1.5" fill="#{i % 4096:03x}"/>' for i in range(1400))
            big = "```svg\n" + template.replace('<g id="body">', f'<g id="sparkles">{filler}</g><g id="body">') + "\n```"
            await b.js("document.getElementById('svg-paste-btn').click()")
            await b.js(f"""(() => {{ document.getElementById('svg-paste-input').value = {json.dumps(big)};
                document.getElementById('svg-paste-apply').click(); }})()""")
            await b.wait_for("!!window.__avatarCall.state.customSvg", what="pasted SVG")
            b_len = await b.js("window.__avatarCall.state.customSvg.length")
            check(b_len > 3 * 16000, f"B: pasted {b_len // 1024} KB SVG accepted (code fence stripped)")

            for p in pages:
                await p.js("document.getElementById('join-btn').click()")
            for p in pages:
                await p.wait_for("window.__avatarCall.state.call?.state === 'connected'", timeout=30,
                                 what="peer connection")
                await p.wait_for("!document.getElementById('chat-input').disabled", timeout=15, what="chat channel")
                check(True, f"{p.name}: connected peer-to-peer, chat channel open")

            # Chat both ways.
            async def say(p, text):
                await p.js(f"""(() => {{ const i = document.getElementById('chat-input'); i.value = {json.dumps(text)};
                    document.getElementById('chat-form').requestSubmit(); }})()""")
            await say(a, "Hi Bob! <b>not bold</b>")
            await b.wait_for("[...document.querySelectorAll('#chat-log li.theirs .text')].some(e => e.textContent === 'Hi Bob! <b>not bold</b>')",
                             what="chat from A")
            check(await b.js("!document.querySelector('#chat-log b')"), "B: chat text is shown as plain text (no HTML injection)")
            await say(b, "Hey Alice 👋")
            await a.wait_for("[...document.querySelectorAll('#chat-log li.theirs .text')].some(e => e.textContent === 'Hey Alice 👋')",
                             what="chat from B")
            check(True, "chat delivered in both directions")

            # Profiles.
            await a.wait_for("document.getElementById('remote-name').textContent === 'Bob'", what="B's name on A")
            await b.wait_for("document.getElementById('remote-name').textContent === 'Alice'", what="A's name on B")
            check(True, "display names exchanged")

            await b.wait_for("!!window.__avatarCall.remoteAvatar.custom", what="A's custom avatar on B")
            await a.wait_for("window.__avatarCall.remoteAvatar.customSvg?.length === " + str(b_len), what="B's big SVG on A")
            check(True, "custom avatars arrive intact on the other side (including a multi-chunk one)")

            # Avatar motion from the other side's face.
            await asyncio.sleep(2.5)
            for p in pages:
                await p.wait_for("window.__avatarCall.remoteAvatar.target.tracking === true", what="remote pose stream")
            check(True, "both sides receive live face-tracking poses")
            roll = await b.js("window.__avatarCall.remoteAvatar.current.roll")
            expected = TILT_RAD / (3.14159 / 4)
            check(abs(roll - expected) < 0.15,
                  f"B sees A's clockwise head tilt as clockwise (roll {roll:+.2f}, expected ≈{expected:+.2f})")
            head_rot = await b.js("""(() => { const g = window.__avatarCall.remoteAvatar.custom.w.head.getAttribute('transform');
                return parseFloat(g.match(/rotate\\(([-\\d.]+)/)[1]); })()""")
            check(abs(head_rot - TILT_RAD * 57.3) < 7, f"A's custom SVG head on B's screen tilts clockwise ({head_rot:+.1f}°)")
            rolls = []
            for _ in range(16):
                rolls.append(await a.js("window.__avatarCall.remoteAvatar.current.roll"))
                await asyncio.sleep(0.25)
            check(max(rolls) - min(rolls) > 0.25, f"A sees B's head rocking (roll range {min(rolls):+.2f}..{max(rolls):+.2f})")

            # Audio: Chrome's fake microphone plays a periodic beep; check its energy arrives at the other side.
            audio_stats = """(async () => {
                const pc = window.__avatarCall.state.call.link.pc; const out = {energy: 0, bytesIn: 0, bytesOut: 0};
                (await pc.getStats()).forEach((s) => {
                  if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.energy += s.totalAudioEnergy || 0; out.bytesIn += s.bytesReceived; }
                  if (s.type === 'outbound-rtp' && s.kind === 'audio') out.bytesOut += s.bytesSent;
                });
                out.senders = pc.getSenders().map((s) => s.track?.kind || null);
                out.directions = pc.getTransceivers().map((t) => t.currentDirection);
                out.polite = window.__avatarCall.state.call.link.polite;
                return out; })()"""
            before = [await p.js(audio_stats) for p in pages]
            await asyncio.sleep(3)
            after = [await p.js(audio_stats) for p in pages]
            for p, s0, s1 in zip(pages, before, after):
                gained = s1["energy"] - s0["energy"]
                print(f"        {p.name}: {s1}")
                check(gained > 1e-4, f"{p.name}: hears the other side's microphone (audio energy +{gained:.4f})")

            # Mute shows up remotely.
            await a.js("document.getElementById('mic-btn').click()")
            await b.wait_for("!document.getElementById('remote-muted').hidden", what="mute badge")
            await a.js("document.getElementById('mic-btn').click()")
            await b.wait_for("document.getElementById('remote-muted').hidden", what="unmute")
            check(True, "mute state shown to the other side")

            if screens:
                Path(screens).mkdir(parents=True, exist_ok=True)
                for p in pages:
                    await p.screenshot(Path(screens) / f"call_{p.name}.png")

            # Leave and rejoin.
            await a.js("document.getElementById('leave-btn').click()")
            await b.wait_for("window.__avatarCall.state.call.state === 'waiting'", timeout=5, what="peer-left")
            check(await b.js("[...document.querySelectorAll('#chat-log li.sys')].some(e => e.textContent.includes('Alice left'))"),
                  "B is told immediately when A leaves")
            await a.js("document.getElementById('rejoin-btn').click()")
            for p in pages:
                await p.wait_for("window.__avatarCall.state.call?.state === 'connected'", timeout=30, what="reconnect")
            check(True, "A rejoins and both reconnect")

            # A third person is turned away.
            c = Page("C", 9333, rock)
            pages.append(c)
            await c.launch(session)
            await c.cmd("Page.navigate", url=url)
            await c.wait_for("!!window.__avatarCall", what="app load")
            await c.js("document.getElementById('join-btn').click()")
            await c.wait_for("window.__avatarCall.state.call?.state === 'full'", timeout=10, what="room full")
            check(await a.js("window.__avatarCall.state.call.state") == "connected", "a third person cannot disrupt the call")

            if screens:
                await a.cmd("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=2, mobile=True)
                await asyncio.sleep(0.5)
                await a.screenshot(Path(screens) / "call_A_phone.png")
                await b.js("document.getElementById('leave-btn').click()")
                await b.cmd("Page.navigate", url=f"http://localhost:{SERVER_PORT}/#room={room}x")
                await b.wait_for("!!window.__avatarCall", what="lobby")
                await asyncio.sleep(1)
                await b.screenshot(Path(screens) / "lobby_B.png")

            # MediaPipe logs informational messages through console.error.
            errors = [(p.name, e) for p in pages for e in p.errors if not str(e).startswith(("INFO:", "W0000", "I0000"))]
            for name, e in errors:
                print(f"  console error on {name}: {e}")
            check(not errors, "no JavaScript errors")
    finally:
        for p in pages:
            await p.close()
        server.terminate()
        server.wait(5)
    print(f"\n{len(passed)} checks passed so far.")


STATIC_PORT = 8798


async def run_cast(screens):
    """Cast mode on static hosting under a sub-path, like GitHub Pages: no Python
    server at all. The sender opens the TV receiver as a preview window, which
    talks to it the same way a Chromecast would (handshake, then WebRTC)."""
    tilt, _ = make_fixtures()
    site = Path(tempfile.mkdtemp(prefix="avatar-pages-"))
    (site / "avatar-call").symlink_to(ROOT / "public")
    static = subprocess.Popen([sys.executable, "-m", "http.server", str(STATIC_PORT), "--bind", "127.0.0.1",
                               "--directory", str(site)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pages = []
    try:
        async with aiohttp.ClientSession() as session:
            await asyncio.sleep(0.5)
            d = Page("D", 9334, tilt)
            pages.append(d)
            await d.launch(session)
            base = f"http://localhost:{STATIC_PORT}/avatar-call/"
            await d.cmd("Page.navigate", url=base)
            await d.wait_for("!!window.__avatarCall && !document.getElementById('landing').hidden", what="landing")
            check(await d.js("document.getElementById('start-btn').disabled && !document.getElementById('serverless-note').hidden"),
                  "static hosting: calls are disabled with an explanation; the app loads from a sub-path")

            await d.js("document.getElementById('cast-mode-btn').click()")
            await d.wait_for("!document.getElementById('cast').hidden && document.getElementById('cast-status').textContent.length > 0",
                             what="cast screen")
            status = await d.js("document.getElementById('cast-status').textContent")
            check("cast-config.json" in status or "Chrome" in status,
                  f"Cast screen explains missing setup ({status[:60]}…)")
            await d.js(f"""(() => {{ const i = document.getElementById('name-input');
                i.value = 'Dana'; i.dispatchEvent(new Event('input', {{bubbles: true}})); }})()""")
            doc = await d.cmd("DOM.getDocument")
            node = await d.cmd("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector="#svg-file")
            await d.cmd("DOM.setFileInputFiles", nodeId=node["nodeId"], files=[str(ROOT / "public/assets/avatar-template.svg")])
            await d.js("document.getElementById('media-btn').click()")
            await d.wait_for("window.__avatarCall.state.tracker?.running && window.__avatarCall.selfAvatar.target.tracking",
                             timeout=90, what="face tracking (assets from sub-path)")
            check(True, "face tracking loads its model from the sub-path")

            await d.js("document.getElementById('cast-preview-btn').click()", gesture=True)  # pop-ups need a click
            tv = await d.attach_tab(session, "receiver.html#preview=", "TV")
            pages.append(tv)
            await tv.wait_for("!!window.__avatarTv?.session?.link?.connected", timeout=20, what="WebRTC link to TV")
            await tv.wait_for("document.getElementById('idle').hidden", what="avatar on screen")
            check(True, "TV preview: handshake over the cast transport, then direct WebRTC")
            await tv.wait_for("document.getElementById('name').textContent === 'Dana'", what="name on TV")
            await tv.wait_for("!!window.__avatarTv.avatar.custom", what="custom SVG on TV")
            check(True, "TV shows the sender's name and custom SVG avatar")
            await asyncio.sleep(2)
            roll = await tv.js("window.__avatarTv.avatar.current.roll")
            expected = TILT_RAD / (3.14159 / 4)
            check(abs(roll - expected) < 0.15, f"TV mirrors the sender's head tilt (roll {roll:+.2f}, expected ≈{expected:+.2f})")
            audio = """(async () => { const r = {e: 0, bytes: 0}; (await window.__avatarTv.session.link.pc.getStats()).forEach((s) => {
                if (s.type === 'inbound-rtp' && s.kind === 'audio') { r.e += s.totalAudioEnergy || 0; r.bytes += s.bytesReceived; } });
                return r; })()"""
            a0 = await tv.js(audio)
            await asyncio.sleep(2)
            a1 = await tv.js(audio)
            check(a1["bytes"] - a0["bytes"] > 2000, f"TV receives the sender's voice ({(a1['bytes'] - a0['bytes']) // 1024} KB in 2 s)")
            check(await tv.js("document.getElementById('audio').muted && !document.getElementById('sound-btn').hidden"),
                  "preview window starts muted (it sits next to the mic) with a Turn on sound button")
            await tv.js("document.getElementById('sound-btn').click()", gesture=True)
            a2 = await tv.js(audio)
            await asyncio.sleep(3)
            a3 = await tv.js(audio)
            check(a3["e"] - a2["e"] > 1e-4, f"after Turn on sound the voice plays (audio energy +{a3['e'] - a2['e']:.4f})")
            await d.js("document.getElementById('cast-voice').click()")
            await tv.wait_for("!document.getElementById('muted').hidden", what="voice-off badge")
            check(True, "turning voice off shows Muted on the TV")
            if screens:
                await tv.cmd("Emulation.setDeviceMetricsOverride", width=1280, height=720, deviceScaleFactor=1, mobile=False)
                await asyncio.sleep(0.5)
                await tv.screenshot(Path(screens) / "tv_preview.png")
                await d.screenshot(Path(screens) / "cast_sender.png")
            await d.js("location.hash = ''")
            await tv.wait_for("!document.getElementById('idle').hidden", timeout=10, what="TV back to idle")
            check(True, "leaving Cast mode returns the TV to its idle screen")

            errors = [(p.name, e) for p in pages for e in p.errors if not str(e).startswith(("INFO:", "W0000", "I0000"))]
            for name, e in errors:
                print(f"  console error on {name}: {e}")
            check(not errors, "no JavaScript errors in Cast mode")
    except AssertionError:
        for p in pages:
            print(f"--- console of {p.name}:")
            for line in p.logs[-15:]:
                print("   ", line[:300])
        raise
    finally:
        for p in pages:
            await p.close()
        static.terminate()
        static.wait(5)
        shutil.rmtree(site, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-screens", metavar="DIR", help="save screenshots here")
    args = parser.parse_args()
    if not CHROME:
        sys.exit("Chrome/Chromium not found")
    try:
        asyncio.run(run(args.keep_screens))
        asyncio.run(run_cast(args.keep_screens))
        print(f"\nAll {len(passed)} checks passed.")
    except AssertionError as err:
        print(f"\nFAILED: {err}")
        sys.exit(1)

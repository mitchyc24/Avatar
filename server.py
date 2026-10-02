#!/usr/bin/env python3
"""Avatar Call server.

Serves the web app, relays WebRTC signaling between the two people in a room,
and can optionally open a public HTTPS link through a Cloudflare quick tunnel.

Audio, text chat and avatar motion all flow peer-to-peer once a call is set up;
this server only sees the short handshake messages. Camera video never leaves
the browser that captured it.
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import mimetypes
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CONFIG_FILE = ROOT / "config.json"
CERT_DIR = ROOT / "certs"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
MAX_PEERS = 2
MAX_MESSAGE_BYTES = 64 * 1024
RATE_WINDOW_S = 10
RATE_MAX_MESSAGES = 400
# A peer whose socket drops gets this long to reconnect before the other side is told they left.
RECONNECT_GRACE_S = 10

DEFAULT_ICE_SERVERS = [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
    {"urls": "stun:stun.cloudflare.com:3478"},
]

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/octet-stream", ".task")

log = logging.getLogger("avatar")


# --------------------------------------------------------------------------- rooms

class Member:
    def __init__(self, client_id, ws):
        self.client_id = client_id
        self.peer_id = secrets.token_urlsafe(6)
        self.ws = ws
        self.removal = None  # pending grace-period removal task
        self.recent = []  # message timestamps for rate limiting


class Room:
    def __init__(self, room_id):
        self.id = room_id
        self.members = {}  # client_id -> Member

    def others(self, member):
        return [m for m in self.members.values() if m is not member]


rooms = {}


async def send(member, payload):
    if member.ws is None or member.ws.closed:
        return
    try:
        await member.ws.send_str(json.dumps(payload))
    except (ConnectionResetError, RuntimeError):
        pass


async def remove_member(room, member, notify=True):
    if room.members.get(member.client_id) is not member:
        return
    del room.members[member.client_id]
    if notify:
        for other in room.others(member):
            await send(other, {"type": "peer-left", "id": member.peer_id})
    if not room.members:
        rooms.pop(room.id, None)


async def remove_after_grace(room, member):
    try:
        await asyncio.sleep(RECONNECT_GRACE_S)
    except asyncio.CancelledError:
        return
    await remove_member(room, member)


def rate_limited(member):
    now = time.monotonic()
    member.recent = [t for t in member.recent if now - t < RATE_WINDOW_S]
    member.recent.append(now)
    return len(member.recent) > RATE_MAX_MESSAGES


async def ws_handler(request):
    room_id = request.match_info["room"]
    client_id = request.query.get("client", "")
    if not ID_RE.match(room_id) or not ID_RE.match(client_id):
        raise web.HTTPBadRequest(text="bad room or client id")

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MESSAGE_BYTES)
    await ws.prepare(request)

    room = rooms.setdefault(room_id, Room(room_id))
    member = room.members.get(client_id)
    if member is not None:
        # Same browser tab reconnecting (e.g. a network blip): swap in the new socket
        # silently so the peer-to-peer call carries on untouched.
        if member.removal:
            member.removal.cancel()
            member.removal = None
        old = member.ws
        member.ws = ws
        if old is not None and not old.closed:
            await old.close()
        reconnected = True
    else:
        if len(room.members) >= MAX_PEERS:
            await ws.send_str(json.dumps({"type": "full"}))
            await ws.close()
            if not room.members:
                rooms.pop(room_id, None)
            return ws
        member = Member(client_id, ws)
        room.members[client_id] = member
        reconnected = False

    await send(member, {
        "type": "welcome",
        "id": member.peer_id,
        "peers": [m.peer_id for m in room.others(member)],
        "reconnected": reconnected,
    })
    if not reconnected:
        for other in room.others(member):
            await send(other, {"type": "peer-joined", "id": member.peer_id})

    said_bye = False
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            if rate_limited(member):
                await ws.close(code=4008, message=b"rate limited")
                break
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("type")
            if kind == "signal":
                for other in room.others(member):
                    await send(other, {"type": "signal", "from": member.peer_id, "data": data.get("data")})
            elif kind == "bye":
                said_bye = True
                break
    finally:
        if member.ws is ws:
            member.ws = None
            if said_bye:
                await remove_member(room, member)
            else:
                member.removal = asyncio.create_task(remove_after_grace(room, member))
    return ws


# --------------------------------------------------------------------------- http

def load_config():
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


def ice_servers(config):
    servers = list(config.get("iceServers") or DEFAULT_ICE_SERVERS)
    turn = config.get("turn")
    if turn and turn.get("secret"):
        # coturn "use-auth-secret" style short-lived credentials.
        expiry = int(time.time()) + int(turn.get("ttl", 6 * 3600))
        username = f"{expiry}:avatar"
        digest = hmac.new(turn["secret"].encode(), username.encode(), hashlib.sha1).digest()
        servers.append({"urls": turn["urls"], "username": username,
                        "credential": base64.b64encode(digest).decode()})
    elif turn and turn.get("username"):
        servers.append({"urls": turn["urls"], "username": turn["username"],
                        "credential": turn.get("credential", "")})
    return servers


async def config_handler(request):
    config = request.app["config"]
    return web.json_response({
        "iceServers": ice_servers(config),
        "publicUrl": request.app["shared"]["public_url"],
    }, headers={"Cache-Control": "no-store"})


async def index_handler(request):
    return web.FileResponse(PUBLIC / "index.html", headers={"Cache-Control": "no-cache"})


async def legacy_room_handler(request):
    # Rooms used to live at /r/<id>; they're now in the fragment so static hosting works.
    room = request.match_info["room"]
    if not ID_RE.match(room):
        raise web.HTTPNotFound()
    raise web.HTTPFound(f"/#room={room}")


def static_file(name):
    async def handler(request):
        return web.FileResponse(PUBLIC / name, headers={"Cache-Control": "no-cache"})
    return handler


@web.middleware
async def security_headers(request, handler):
    response = await handler(request)
    host = request.host
    response.headers.setdefault("Content-Security-Policy", "; ".join([
        "default-src 'self'",
        # Google's Cast sender SDK (Cast mode only). No scheme: on http://localhost it loads its parts over http.
        "script-src 'self' 'wasm-unsafe-eval' www.gstatic.com",
        f"connect-src 'self' wss://{host} ws://{host} www.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: mediastream:",
        "style-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
    ]))
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), display-capture=()")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    if request.path.startswith("/vendor/"):
        response.headers["Cache-Control"] = "public, max-age=604800"
    elif request.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def make_app(public_url=None):
    app = web.Application(middlewares=[security_headers])
    app["config"] = load_config()
    app["shared"] = {"public_url": public_url}  # mutable after startup (tunnel URL arrives later)
    app.router.add_get("/", index_handler)
    app.router.add_get("/r/{room}", legacy_room_handler)
    app.router.add_get("/receiver.html", static_file("receiver.html"))
    app.router.add_get("/cast-config.json", static_file("cast-config.json"))
    app.router.add_get("/ws/{room}", ws_handler)
    app.router.add_get("/api/config", config_handler)
    app.router.add_static("/assets", PUBLIC / "assets")
    app.router.add_static("/vendor", PUBLIC / "vendor")
    return app


# --------------------------------------------------------------------------- https + tunnel

def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))  # no packets are sent; this just picks the outbound interface
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def self_signed_context(ip):
    CERT_DIR.mkdir(exist_ok=True)
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    marker = CERT_DIR / "ip.txt"
    if not cert.exists() or not marker.exists() or marker.read_text() != ip:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
            "-keyout", str(key), "-out", str(cert), "-subj", "/CN=Avatar Call (local)",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ], check=True, capture_output=True)
        marker.write_text(ip)
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(cert, key)
    return ctx


def find_cloudflared():
    local = ROOT / "bin" / "cloudflared"
    if local.exists():
        return str(local)
    return shutil.which("cloudflared")


async def start_tunnel(app, port):
    exe = find_cloudflared()
    if not exe:
        print("cloudflared not found. Run ./setup.sh --tunnel to download it.", file=sys.stderr)
        return None
    proc = await asyncio.create_subprocess_exec(
        exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    url_re = re.compile(rb"https://[a-z0-9-]+\.trycloudflare\.com")
    shared = app["shared"]

    async def pump():
        while line := await proc.stderr.readline():
            if shared["public_url"] is None and (m := url_re.search(line)):
                shared["public_url"] = m.group(0).decode()
                banner(f"Public link ready: {shared['public_url']}",
                       "Start a call from the page, then send your friend the invite link it shows.")
            elif b" ERR " in line and b"Unauthorized" not in line:
                log.debug("cloudflared: %s", line.decode(errors="replace").rstrip())

    shared["tunnel_reader"] = asyncio.create_task(pump())
    return proc


def banner(*lines):
    width = max(len(l) for l in lines) + 4
    print("\n" + "=" * width)
    for l in lines:
        print(f"  {l}")
    print("=" * width + "\n", flush=True)


async def main():
    parser = argparse.ArgumentParser(description="Avatar Call: peer-to-peer SVG avatar chat.")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--share", action="store_true",
                        help="open a public HTTPS link via a Cloudflare quick tunnel")
    parser.add_argument("--lan", action="store_true",
                        help="also serve HTTPS on your local network (self-signed certificate)")
    parser.add_argument("--lan-port", type=int, default=8788)
    parser.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.INFO if args.verbose else logging.WARNING)

    if not (PUBLIC / "vendor" / "mediapipe" / "face_landmarker.task").exists():
        print("Face-tracking files are missing. Run ./setup.sh first.", file=sys.stderr)
        sys.exit(1)

    app = make_app()
    runner = web.AppRunner(app, access_log=None if not args.verbose else logging.getLogger("aiohttp.access"))
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", args.port).start()
    local_url = f"http://localhost:{args.port}"
    lines = [f"Avatar Call running at {local_url}"]

    if args.lan:
        ip = lan_ip()
        await web.TCPSite(runner, "0.0.0.0", args.lan_port, ssl_context=self_signed_context(ip)).start()
        lines.append(f"On your network: https://{ip}:{args.lan_port}  (accept the certificate warning)")

    tunnel = None
    if args.share:
        lines.append("Opening a public link through Cloudflare...")
        tunnel = await start_tunnel(app, args.port)
    else:
        lines.append("Local only. Use ./avatar --share to get a link you can send to a friend.")
    banner(*lines)

    if not args.no_open:
        webbrowser.open(local_url)

    try:
        await asyncio.Event().wait()
    finally:
        if tunnel and tunnel.returncode is None:
            tunnel.terminate()
            await tunnel.wait()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

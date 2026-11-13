"""Local server for the Wasm build: cross-origin isolation headers, single byte ranges, brotli for code.

Usage: python serve.py --root <staged Wasm folder> [--port 8800] [--bind 127.0.0.1] [--immutable] [--log-json <file>]
                       [--net none|300mbit|50mbit|10mbit|<Mbit>/<ms>|<Mbit>:<ms>] [--tls-cert <pem> --tls-key <pem>]
                       [--allow-host <name> ...] [--serve-any-file]

--tls-cert/--tls-key serve HTTPS with a certificate the user supplies, for LAN and phone tests: a page opened from
another device needs a secure context (cross-origin isolation, SharedArrayBuffer and WebGPU are secure-context only), and
http://<LAN address> is not one. The tool never makes or fetches a certificate; bind a LAN address with --bind.

Part of the engine's run harness (Engine/Platforms/Wasm/Build/Tools/web). Network profiles: 300 Mbit/s 20 ms default,
50 Mbit/s 40 ms secondary, 10 Mbit/s 80 ms for a slow link.

Every response carries COOP/COEP/CORP (SharedArrayBuffer needs a cross-origin isolated page). `Range: bytes=a-b` gets a 206
with Content-Range (WasmFS's fetch backend reads containers in chunks). `<file>.br` is served with Content-Encoding: br to a
request without a Range when the client accepts it; range reads
always get the raw bytes.

--net shapes what the server sends: one bandwidth shared by every connection and one
round trip before each response's first byte. It is done here, not with Chrome's network emulation, because DevTools
throttling of a page does not apply to its service worker's fetches, and the page loads its containers through one.

--exit-after-session <seconds> stops the server once the page is gone: a page opened with ?ue-session=1 keeps one request
to <page folder>/__ue/session open (wasm-harness.js), which the server holds and writes a comment line to every second; when
the last such request has been closed for that many seconds (a closed tab, not a reload, which reconnects within it), the
server exits with 0. UAT's BuildCookRun -run uses it, so the run, and the editor's Launch On task waiting on it, end when the
player closes the tab. The stream's first event names this server; a page whose stream dropped reconnects naming the server
it first reached, and another server's name gets 204 and is not counted, so a tab left open from an earlier run on the same
port does not keep this run alive. Without the option the path is not served (404).

--game-run (UAT's -run, with --exit-after-session) prints the console lines such a page posts to <page folder>/__ue/log on
stdout, the client output UAT reads (an -unattended run's test-exit line, as in a native client's log), and stops the server
when the game ends, exiting with its code (UE_RUN DONE <code> or HARNESS EXIT <code>; 1 after UE_RUN ERROR or HARNESS ABORT).
Without the option the path is a 404 and the page stops posting.

What it serves, and to whom (a phone on the LAN reaches it too):
- Only files under --root after following links; never a dotfile, a dot-folder or a raw .br file, as named or through a link
  (a .br goes out only as a file's Content-Encoding: br), and never the --log-json file. In a stage (wasm-manifest.json
  or wasm-cache.json at the root) only the root's files and the files the root's .json lists name are served;
  --serve-any-file serves every other file under the root too (development).
- Only requests whose Host is an IP address, localhost, this computer's name or an --allow-host name: a page on another site
  whose name a DNS rebinding points at this server is refused. __ue/session and __ue/hold also refuse an Origin other than
  the Host's own, and __ue/hold answers only this computer.
- A connection that sends nothing for 30 s (an idle keep-alive, half a request head, a TLS handshake that stalls) is closed,
  and at most 256 connections are served at once.
- A bad Range (a value no integer can hold) answers 416 and a bad Content-Length 400, never a dropped connection.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import secrets
import ssl
import threading
import time
import re
import webbrowser
import socket
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

MIME = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".wgsl": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}
NO_CACHE_NAMES = {"index.html", "wasm-manifest.json"}
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
# The named profiles: (Mbit/s, round trip ms). 50mbit is the plan's reference profile (B1); 10mbit a slow connection.
# 300mbit: the timing target (about the US average connection), 20 ms round trip
NET_PROFILES = {"none": None, "300mbit": (300.0, 20.0), "50mbit": (50.0, 40.0), "10mbit": (10.0, 80.0)}


def parse_net(text: str | None) -> tuple[float, float] | None:
    """'none', a profile name, or '<Mbit>/<ms>' or '<Mbit>:<ms>' (UAT -WasmNet passes the colon form) -> (bytes per second,
    round trip seconds), or None for no shaping."""
    if not text or text == "none":
        return None
    if text in NET_PROFILES:
        mbit, rtt_ms = NET_PROFILES[text]
    else:
        mbit_text, _, rtt_text = text.replace(":", "/").partition("/")
        mbit, rtt_ms = float(mbit_text.lower().removesuffix("mbit")), float(rtt_text or 0)
    if mbit <= 0:
        raise ValueError(f"--net {text}: the bandwidth must be above zero")
    return mbit * 1e6 / 8, rtt_ms / 1000


class Shaper:
    """One token bucket for every connection: send() blocks until the shared bandwidth allows the bytes."""

    def __init__(self, bytes_per_s: float, rtt_s: float):
        self.rate, self.rtt = bytes_per_s, rtt_s
        self.lock = threading.Lock()
        self.next_free = time.monotonic()

    def wait(self, nbytes: int) -> None:
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_free)
            self.next_free = start + nbytes / self.rate
            delay = self.next_free - now
        if delay > 0:
            time.sleep(delay)


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """Return (first, last) inclusive for one satisfiable range, None for no/ignored range, "unsatisfiable" otherwise."""
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if not match:
        return None  # multi-range or unknown unit: serve the whole file (RFC 9110 allows ignoring Range)
    first_text, last_text = match.groups()
    if first_text == "" and last_text == "":
        return None
    try:
        if first_text == "":
            suffix = int(last_text)
            if suffix == 0 or size == 0:
                return "unsatisfiable"
            return max(0, size - suffix), size - 1
        first = int(first_text)
        if first >= size:
            return "unsatisfiable"
        last = size - 1 if last_text == "" else min(int(last_text), size - 1)
    except ValueError:  # more digits than int() takes (4300 by default): a range no file has
        return "unsatisfiable"
    if last < first:
        return "unsatisfiable"
    return first, last


HOLD_SECONDS = 30.0  # how long a reused server waits for the page a second launch opens on it to connect


class Sessions:
    """The pages holding a /__ue/session request open (--exit-after-session)."""

    def __init__(self):
        self.lock = threading.Lock()
        # this server's id: the session stream's first event names it, and a page that lost its stream reconnects with it
        # (?server=<id>), so a tab left open from an earlier run is refused here instead of keeping this run alive
        self.server_id = secrets.token_hex(8)
        self.live = 0
        self.seen = False
        self.empty_since = time.monotonic()
        self.hold_until = 0.0  # a second launch handing its page to this server keeps it up until the page connects
        self.stopping = False

    def enter(self) -> None:
        with self.lock:
            self.live += 1
            self.seen = True
            self.hold_until = 0.0  # the page a hold was for has arrived; from here the usual grace applies

    def leave(self) -> None:
        with self.lock:
            self.live -= 1
            if self.live == 0:
                self.empty_since = time.monotonic()

    def hold(self, seconds: float) -> bool:
        """Keep the server up for a page about to open (--port-tries reuse); False once it has decided to stop."""
        with self.lock:
            if self.stopping:
                return False
            self.hold_until = max(self.hold_until, time.monotonic() + seconds)
            return True

    def expire(self, grace: float) -> bool:
        """True, and from then on refusing holds, once the last page left at least grace seconds ago and no hold is
        pending. Deciding here under the lock means a hold either lands first or is refused, never answered and then dropped."""
        with self.lock:
            now = time.monotonic()
            if not self.seen or self.live > 0 or now < self.hold_until or now - self.empty_since < grace:
                return False
            self.stopping = True
            return True


# the end markers as the engine and the page print them: a line of their own, never inside another line
GAME_END = re.compile(r"^(?:UE_RUN DONE|HARNESS EXIT) (-?\d+)\s*$|^(?:UE_RUN ERROR|HARNESS ABORT)\b")
LOG_BODY_MAX = 4 << 20  # bytes per POST; the page sends at most about 512 K characters in one
# -testexit=<phrase> in an echoed command line: UAT skips any read of the output that holds "-testexit=" (and would take the
# phrase in it for the game's test-exit line), so the echo is printed without it and no read is ever lost to it
TEST_EXIT_ARG = re.compile(r'-testexit=(?:(\\?")(?:(?!\1).)*\1|\S+)')


class GameRun:
    """--game-run: the page's console lines (POST __ue/log, wasm-harness.js) printed on stdout, and the game's end with its
    code: UE_RUN DONE <n> or HARNESS EXIT <n>; 1 after UE_RUN ERROR or HARNESS ABORT (the page's error card)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.code: int | None = None
        self.ended = threading.Event()

    def lines(self, text: str) -> None:
        with self.lock:
            # one console call per line; its own line breaks arrive as continuation lines that start with a tab
            for line in (text[:-1] if text.endswith("\n") else text).split("\n"):
                sys.stdout.write(TEST_EXIT_ARG.sub("-testexit (not shown)", line) + "\n")
                end = GAME_END.search(line) if self.code is None else None
                if end:
                    self.code = int(end.group(1)) if end.group(1) is not None else 1
                    self.ended.set()
            sys.stdout.flush()


def _host_name(host_header: str) -> str:
    """The name or address in a Host header, without the port and the brackets of an IPv6 address, in lower case"""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host[1:]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _is_ip(name: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def _root_json(root: str, skip: str | None = None) -> list:
    """The root's .json files (os.DirEntry), without skip (the --log-json file: a log, not a list, and it changes per response)"""
    return [entry for entry in os.scandir(root) if entry.is_file() and entry.name.endswith(".json")
            and not (skip and os.path.realpath(entry.path) == skip)]


def _stage_listed(root: str, skip: str | None = None) -> set[str] | None:
    """The paths a stage's root .json lists (every string value, as wasm-manifest.json and wasm-cache.json do with "url"),
    as root-relative paths with forward slashes and no dot segments, or None when the root is not a stage (neither
    wasm-manifest.json nor wasm-cache.json there). Not only the files there now: a listed file copied in later is served."""
    try:
        names = [entry.name for entry in _root_json(root, skip)]
    except OSError:
        return None
    if "wasm-manifest.json" not in names and "wasm-cache.json" not in names:
        return None
    listed: set[str] = set()

    def walk(value):
        if isinstance(value, str):
            # as translate_path reads a request: no query or fragment, %-decoded, "./" and "a/../" folded
            relative = posixpath.normpath("/" + unquote(value.split("?", 1)[0].split("#", 1)[0]).replace("\\", "/")).lstrip("/")
            if relative and relative != ".":
                listed.add(relative)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for name in names:
        try:
            with open(os.path.join(root, name), encoding="utf-8") as handle:
                walk(json.load(handle))
        except (OSError, ValueError):
            continue
    return listed


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: the fetch backend issues many small range requests
    # a connection that sends nothing for this long (an idle keep-alive, half a request head, a stalled TLS handshake) is
    # closed: StreamRequestHandler applies it to the socket, and a timed-out read ends the connection
    timeout = 30
    allow_hosts: set[str] = set()  # --allow-host names, besides IP addresses, localhost and this computer's names
    serve_any_file = False  # --serve-any-file: in a stage, also files its .json lists do not name
    log_json_path: str | None = None  # the --log-json file, never served
    _listed_cache: tuple = (None, None)  # (the root .json files' names and times, the files they list)
    _own_names_cache: frozenset | None = None  # this computer's names, looked up once (getfqdn can wait on a resolver)

    @staticmethod
    def _own_names() -> frozenset:
        if Handler._own_names_cache is None:
            names = {socket.gethostname().lower()}
            try:
                names.add(socket.getfqdn().lower())
            except OSError:
                pass
            Handler._own_names_cache = frozenset(names)
        return Handler._own_names_cache
    _listed_lock = threading.Lock()
    immutable = False
    log_json = None  # an open file: one JSON line per response, for load_report.py
    in_flight = 0  # responses between their request and their last byte (the status page, /__ue/inflight)
    started = 0  # responses begun and ended since the server started (the same page)
    ended = 0
    peak = 0  # the most responses in flight at once since the server started (the same page)
    in_flight_lock = threading.Lock()
    log_lock = threading.Lock()
    shaper: Shaper | None = None
    sessions: Sessions | None = None
    game: GameRun | None = None

    def log_message(self, fmt, *args):  # quieter than the default: one line per request on stderr
        # a request line that did not parse (400, 414, 505) is logged before it has a path, and command is reset to None
        # for every new request line, so a malformed request on a kept-alive connection has no stale path either
        path = self.path.split("?")[0] if getattr(self, "command", None) else ""
        if self.game is not None and path.endswith("/__ue/log"):
            return  # the forwarded lines themselves are the output
        if path == "/__ue/inflight":
            return  # polled twice a second while a run settles
        sys.stderr.write("serve: " + (fmt % args) + "\n")

    def end_headers(self):
        # on every response, errors included, as the host templates' "Header always set" does
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _common_headers(self, path: Path):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Accept-Ranges", "bytes")
        if self.immutable and path.name not in NO_CACHE_NAMES:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")

    def _inside_root(self, path: Path) -> bool:
        """True when the file a path names, after following every link, is under --root: a link in the stage (or a .br
        sibling that is one) must not serve a file from outside it"""
        try:
            root = os.path.realpath(self.directory)
            return os.path.commonpath([root, os.path.realpath(path)]) == root
        except (OSError, ValueError):  # another drive on Windows, or an unresolvable path
            return False

    def _host_allowed(self) -> bool:
        """The Host names this server: an IP address (a DNS rebinding needs a name), localhost, this computer's own names or an
        --allow-host name. A request without Host (HTTP/1.0) is allowed. A rebound name is a page of another site reading
        this server through the browser"""
        header = self.headers.get("Host")
        if not header:
            return True
        name = _host_name(header)
        if _is_ip(name) or name in ("localhost", "localhost.") or name.rstrip(".") in Handler.allow_hosts:
            return True
        own = set(Handler._own_names())
        bind = self.server.server_address[0]
        if isinstance(bind, str) and bind and not _is_ip(bind):
            own.add(bind.lower())
        return name in own or name.rstrip(".") in own

    def _origin_allowed(self) -> bool:
        """No Origin, or the page's own (scheme and the Host it reached): a control endpoint must not answer another site"""
        origin, host = self.headers.get("Origin"), self.headers.get("Host")
        return origin is None or (host is not None and origin.lower() in (f"http://{host}".lower(), f"https://{host}".lower()))

    def _refuse(self, status: HTTPStatus) -> None:
        self.close_connection = True
        self.send_response(status)
        self._common_headers(Path("refused"))
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def _listed(self) -> set[str] | None:
        """_stage_listed for --root, read again when a root .json changes (an updated stage)"""
        try:
            stamp = tuple(sorted((entry.name, entry.stat().st_mtime_ns, entry.stat().st_size)
                                 for entry in _root_json(self.directory, Handler.log_json_path)))
        except OSError:
            stamp = ()
        with Handler._listed_lock:
            if Handler._listed_cache[0] != stamp:
                Handler._listed_cache = (stamp, _stage_listed(self.directory, Handler.log_json_path))
            return Handler._listed_cache[1]

    def _body_allowed(self, path: Path) -> bool:
        """A file this server may send bytes of (the requested file, or its .br sibling): under --root after links, not the
        --log-json file, and no dot segment in its path under the root, as named or after links (a link "ok.txt" to ".env")"""
        if not self._inside_root(path):
            return False
        real = os.path.realpath(path)
        if Handler.log_json_path and real == Handler.log_json_path:
            return False
        try:
            named = os.path.relpath(os.path.abspath(path), os.path.abspath(self.directory))
            resolved = os.path.relpath(real, os.path.realpath(self.directory))
        except ValueError:
            return False
        return not any(part.startswith(".") for relative in (named, resolved) for part in relative.replace(os.sep, "/").split("/"))

    def _servable(self, local: Path) -> bool:
        """_body_allowed; no dot segment in the request, and not a raw .br (any case, as named or after links); in a stage,
        a root file or one its .json lists name (unless --serve-any-file)"""
        if not self._body_allowed(local):
            return False
        # the path as requested (a link inside the root keeps its own name); containment was checked above
        relative = os.path.relpath(os.path.abspath(local), os.path.abspath(self.directory)).replace(os.sep, "/")
        request_parts = [part for part in urlsplit(self.path).path.split("/") if part]
        if any(part.startswith(".") or part.startswith("%2e") for part in (p.lower() for p in request_parts)):
            return False
        if local.name.lower().endswith(".br") or os.path.realpath(local).lower().endswith(".br"):
            return False
        if Handler.serve_any_file or "/" not in relative:
            return True
        listed = self._listed()
        return listed is None or relative in listed

    def _resolve(self) -> Path | None:
        local = Path(self.translate_path(self.path))
        if local.is_dir():
            local = local / "index.html"
        return local if local.is_file() and self._servable(local) else None

    def do_HEAD(self):
        if not self._host_allowed():
            self._refuse(HTTPStatus.FORBIDDEN)
            return
        self._serve(head=True)

    def do_GET(self):
        if not self._host_allowed():
            self._refuse(HTTPStatus.FORBIDDEN)
            return
        if self.sessions is not None and self.path.split("?")[0].endswith("/__ue/session"):
            if not self._origin_allowed():
                self._refuse(HTTPStatus.FORBIDDEN)
                return
            self._session()
            return
        if self.path.split("?")[0] == "/__ue/hold":
            # a second launch on this computer asks (serve.py's _hold); nothing else may keep the server up
            local_client = self.client_address[0] in ("127.0.0.1", "::1", self.server.server_address[0]) \
                or self.client_address[0].startswith("::ffff:127.")
            if not self._origin_allowed() or not local_client:
                self._refuse(HTTPStatus.FORBIDDEN)
                return
            # Only a server tracking sessions (a launcher's) takes a second launch's page: one without would never stop
            held = self.sessions is not None and self.sessions.hold(HOLD_SECONDS)
            self.send_response(HTTPStatus.NO_CONTENT if held else HTTPStatus.SERVICE_UNAVAILABLE)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.split("?")[0] == "/__ue/inflight":
            self._in_flight()
            return
        self._serve(head=False)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:  # not a number: the body cannot be read or skipped
            self._refuse(HTTPStatus.BAD_REQUEST)
            return
        found = self.game is not None and self.path.split("?")[0].endswith("/__ue/log")
        # only the served page in a browser on this computer (UAT's -run serves 127.0.0.1): a loopback client, its own
        # header (another site's page would need a CORS preflight, which is not answered), this server's own address as
        # the Host (a rebound name is refused; no port for 80 and 443) and, when the browser names one, that origin
        bind, port = self.server.server_address[:2]
        names = {bind, "127.0.0.1", "localhost", "[::1]"} - {"", "0.0.0.0", "::"}
        hosts = {f"{name}:{port}" for name in names} | (names if port in (80, 443) else set())
        host, origin = self.headers.get("Host"), self.headers.get("Origin")
        allowed = (found and self.client_address[0] in ("127.0.0.1", "::1") and self.headers.get("X-UE-Log") == "1"
                   and host in hosts and origin in (None, f"http://{host}", f"https://{host}"))
        status = HTTPStatus.NOT_FOUND if not found else HTTPStatus.FORBIDDEN if not allowed else (
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE if length > LOG_BODY_MAX else HTTPStatus.NO_CONTENT)
        if status == HTTPStatus.NO_CONTENT:
            self.game.lines(self.rfile.read(length).decode("utf-8", "replace") if length > 0 else "")
        else:
            self.close_connection = True  # the body is not read
        self.send_response(status)
        self._common_headers(Path("log"))
        self.send_header("Content-Length", "0")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    def _in_flight(self):
        """The responses in flight now, how many began and ended, and the most at once, as JSON: a reader waiting for the
        server to go quiet (run_page.py --settle-status) reads this, because the byte log gets a response's line only when
        its last byte is sent (at 50 Mbit/s one container outlasts the quiet period: cold visits of a pair ended mid-download)"""
        with Handler.in_flight_lock:
            body = json.dumps({"in_flight": Handler.in_flight, "started": Handler.started, "ended": Handler.ended,
                               "peak": Handler.peak}).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _session(self):
        """Hold the page's session request: an event stream of comment lines, one a second. A write fails once the page is
        gone, which is how a closed tab is noticed even when its timers are throttled or the browser was killed. The first
        event names this server. A page that reconnects names the server it first reached (?server=<id>); another server's
        id (a tab left open from an earlier run, or from another project) gets 204, which ends an EventSource for good, and
        is not counted as a session."""
        self.close_connection = True
        known = parse_qs(urlsplit(self.path).query).get("server", [""])[0]
        if known and known != self.sessions.server_id:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._common_headers(Path("session"))
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        self.send_response(HTTPStatus.OK)
        self._common_headers(Path("session"))
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.sessions.enter()
        try:
            self.wfile.write(f"event: ue-server\ndata: {self.sessions.server_id}\n\n".encode("ascii"))
            while True:
                self.wfile.write(b": ue-session\n\n")
                self.wfile.flush()
                time.sleep(1.0)
        except OSError:  # BrokenPipe, ConnectionReset or ConnectionAborted: the page closed the request
            pass
        finally:
            self.sessions.leave()

    def _serve(self, head: bool):
        # in flight from the request's first step (resolving and reading the file, the headers) to its last byte, so
        # /__ue/inflight never reads quiet while a response is pending
        with Handler.in_flight_lock:
            Handler.in_flight += 1
            Handler.started += 1
            Handler.peak = max(Handler.peak, Handler.in_flight)
        try:
            self._respond(head)
        finally:
            with Handler.in_flight_lock:
                Handler.in_flight -= 1
                Handler.ended += 1

    def _respond(self, head: bool):
        path = self._resolve()
        if path is None:
            self.send_response(HTTPStatus.NOT_FOUND)
            self._common_headers(Path("missing"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        mime = MIME.get(path.suffix.lower(), "application/octet-stream")
        body_path, encoding = path, None
        range_header = self.headers.get("Range")
        brotli = path.with_name(path.name + ".br")
        # a .br older than its file is stale (the file was replaced after compression): serve the file
        if (not range_header and brotli.is_file() and self._body_allowed(brotli) and brotli.stat().st_mtime >= path.stat().st_mtime
                and "br" in (self.headers.get("Accept-Encoding") or "")):
            body_path, encoding = brotli, "br"
        size = body_path.stat().st_size
        span = parse_range(range_header, size) if encoding is None else None
        if span == "unsatisfiable":
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self._common_headers(path)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        first, last = (0, size - 1) if span is None else span
        length = max(0, last - first + 1)
        self.send_response(HTTPStatus.PARTIAL_CONTENT if span is not None else HTTPStatus.OK)
        self._common_headers(path)
        self.send_header("Content-Type", mime)
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        if span is not None:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if head or length == 0:
            self._log_response(path, range_header, 0, encoding, 0)
            return
        started = time.time()
        sent = 0
        try:
            if self.shaper is not None:
                time.sleep(self.shaper.rtt)  # the request's round trip, before the first byte
            sent = self._send_body(body_path, first, length)
        finally:
            # the log line before _serve drops the count, so a reader that sees it drop also finds the response in the log
            self._log_response(path, range_header, sent, encoding, started)

    def _log_response(self, path: Path, range_header: str | None, sent: int, encoding: str | None, started: float):
        if self.log_json is None:
            return
        record = {"t0": round(started or time.time(), 4), "t1": round(time.time(), 4), "path": self.path.split("?")[0],
                  "range": range_header, "bytes": sent, "enc": encoding, "method": self.command}
        with self.log_lock:
            self.log_json.write(json.dumps(record) + "\n")
            self.log_json.flush()

    def _send_body(self, body_path: Path, first: int, length: int) -> int:
        with open(body_path, "rb") as handle:
            handle.seek(first)
            remaining = length
            while remaining:
                chunk = handle.read(min(1 << 20 if self.shaper is None else 1 << 14, remaining))
                if not chunk:
                    break
                if self.shaper is not None:
                    self.shaper.wait(len(chunk))
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                    # the client went away (Windows: aborted), or stopped reading for the handler's timeout
                    self.close_connection = True
                    break
                remaining -= len(chunk)
        return length - remaining


class StageServer(ThreadingHTTPServer):
    """Port reuse per platform: on Windows SO_REUSEADDR lets a second server bind a busy port while the old one
    keeps answering, so it stays off and SO_EXCLUSIVEADDRUSE is set; on Linux SO_REUSEADDR stays on, so the
    warm load of a pair can bind the cold load's port while its connections sit in TIME_WAIT."""
    allow_reuse_address = os.name != "nt"
    max_connections = 256  # served at once (one thread each); a connection past that is closed at once

    def process_request(self, request, client_address):
        if not hasattr(self, "_slots"):
            self._slots = threading.BoundedSemaphore(self.max_connections)
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class TLSServer(StageServer):
    """HTTPS: each accepted connection is wrapped without the handshake, so the handshake runs in the connection's own thread
    (a slow or broken client never blocks the accept loop)."""
    tls: ssl.SSLContext | None = None

    def get_request(self):
        connection, address = super().get_request()
        return self.tls.wrap_socket(connection, server_side=True, do_handshake_on_connect=False), address

    def handle_error(self, request, client_address):  # a client that rejects the certificate: one line, not a traceback
        error = sys.exc_info()[1]
        if isinstance(error, (ssl.SSLError, ConnectionResetError, BrokenPipeError)):
            sys.stderr.write(f"serve: TLS {client_address[0]}: {error}\n")
            return
        super().handle_error(request, client_address)


_TLS_NO_CHECK = None


def http_get(url: str, limit_s: float, max_bytes: int = 1 << 16, method: str = "GET") -> tuple[int, bytes] | None:
    """One request to a server on this computer or the LAN, with a single deadline of limit_s seconds over name
    resolution, connect, send, the status line, the headers and the body: (status, body), or None when no whole answer
    came in time (refused, reset, timed out, not HTTP, a body cut short or longer than max_bytes, no Content-Length on a
    GET). No proxy and no redirect: a 3xx comes back as its status. Over HTTPS the certificate is not checked: these
    are the stage's own servers, often with a certificate the tester made (--tls-cert). HEAD returns an empty body."""
    import ipaddress
    import urllib.parse
    global _TLS_NO_CHECK
    deadline = time.monotonic() + limit_s
    left = lambda: deadline - time.monotonic()
    try:
        parts = urllib.parse.urlsplit(url)
        host, secure = parts.hostname or "127.0.0.1", parts.scheme == "https"
        port = parts.port or (443 if secure else 80)
        try:
            addresses = [(ipaddress.ip_address(host).version, host)]
        except ValueError:  # a name: resolve it on a thread, so a slow resolver also meets the deadline
            found: list = []
            resolver = threading.Thread(target=lambda: found.extend(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)),
                                        daemon=True)
            resolver.start()
            resolver.join(max(0.0, left()))
            # IPv4 first: this computer's servers bind 127.0.0.1, and Windows refuses a ::1 connect only after about 2 s
            addresses = sorted(((4 if family == socket.AF_INET else 6, info[0]) for family, _, _, _, info in found),
                               key=lambda a: a[0] != 4)
        connection = None
        for _, address in addresses:  # each address gets only the time that is left
            if left() <= 0:
                return None
            try:
                connection = socket.create_connection((address, port), timeout=left())
                break
            except OSError:
                connection = None
        if connection is None or left() <= 0:
            return None
        with connection:
            stream = connection
            if secure:
                if _TLS_NO_CHECK is None:
                    context = ssl.create_default_context()
                    context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
                    _TLS_NO_CHECK = context
                connection.settimeout(max(0.001, left()))
                stream = _TLS_NO_CHECK.wrap_socket(connection, server_hostname=host)
            stream.settimeout(max(0.001, left()))
            target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            stream.sendall(f"{method} {target} HTTP/1.0\r\nHost: {parts.netloc}\r\nConnection: close\r\n\r\n".encode("ascii"))
            data, need = bytearray(), None  # need: the whole answer's length, once the headers say it
            while need is None or len(data) < need:
                if left() <= 0 or len(data) > max_bytes + 65536:  # too slow, or more than the headers and the body
                    return None
                stream.settimeout(left())
                chunk = stream.recv(65536)
                if not chunk:
                    break  # the server closed: a body without Content-Length ends here
                data += chunk
                if need is None and b"\r\n\r\n" in data:
                    head = data.partition(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")
                    code = head[0].split()[1] if len(head[0].split()) > 1 else ""
                    length = next((line.split(":", 1)[1].strip() for line in head[1:] if line.lower().startswith("content-length:")), None)
                    if method == "HEAD" or code in ("204", "304") or code.startswith("1"):
                        need = len(data.partition(b"\r\n\r\n")[0]) + 4  # no body by definition (RFC 9110)
                    elif length is not None and length.isdigit():
                        need = len(data.partition(b"\r\n\r\n")[0]) + 4 + int(length)
        head, separator, body = bytes(data).partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0].split()
        if not separator or len(status) < 2 or not status[0].startswith("HTTP/") or not status[1].isdigit():
            return None
        if method == "HEAD" or status[1] in ("204", "304") or status[1].startswith("1"):
            return int(status[1]), b""
        length = next((line.split(":", 1)[1].strip() for line in lines[1:] if line.lower().startswith("content-length:")), None)
        if length is None or not length.isdigit() or len(body) != int(length) or len(body) > max_bytes:
            return None  # cut short, longer than it said, too long, or no length to check it by
        return int(status[1]), body
    except Exception:  # refused, reset, timed out, TLS, a bad URL, port or name: no answer, never an error for the caller
        return None


def _serves_same_stage(bind: str, port: int, root: str, skip: str | None = None) -> bool:
    """True when the server on this port answers each of this stage's root files byte for byte (--port-tries).
    wasm-cache.json checks the game's files by sha1 but lists none at the root, so the page's own files (index.html, sw.js,
    the scripts) are compared too: two stages of the same game data with different pages are different stages. At most
    10 s in all (http_get: one deadline over each whole exchange). skip: this launch's --log-json file (never served)."""
    import urllib.parse
    deadline = time.monotonic() + 10.0
    host = "127.0.0.1" if bind in ("0.0.0.0", "") else bind
    try:
        # the files a server of this stage answers: not .br files (Content-Encoding only) and not dotfiles (never served)
        names = sorted(entry.name for entry in os.scandir(root)
                       if entry.is_file() and not entry.name.lower().endswith(".br") and not entry.name.startswith(".")
                       and not (skip and os.path.realpath(entry.path) == skip))
    except OSError:
        return False
    if "wasm-cache.json" not in names:
        return False
    for name in names:
        try:
            with open(os.path.join(root, name), "rb") as handle:
                mine = handle.read()
        except OSError:
            return False
        answer = http_get(f"http://{host}:{port}/{urllib.parse.quote(name)}", deadline - time.monotonic(), len(mine))
        if answer != (HTTPStatus.OK, mine):
            return False
    return True


def _hold(bind: str, port: int) -> bool:
    """True when the server on this port tracks sessions and has agreed to stay up for a page about to open (/__ue/hold)."""
    answer = http_get(f"http://{'127.0.0.1' if bind in ('0.0.0.0', '') else bind}:{port}/__ue/hold", 2.0, 0)
    return answer is not None and answer[0] == HTTPStatus.NO_CONTENT


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=8800, help="0 picks a free port (printed, and used by --open)")
    parser.add_argument("--port-tries", type=int, default=1, metavar="N",
                        help="when --port is busy, try the next N-1 ports, then a free one (a launcher's stable origin)")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--immutable", action="store_true")
    parser.add_argument("--log-json", default=None, help="append one JSON line per response (time, path, range, bytes sent)")
    parser.add_argument("--tls-cert", default=None, help="PEM certificate (chain) for HTTPS (with --tls-key)")
    parser.add_argument("--tls-key", default=None, help="PEM private key of --tls-cert")
    parser.add_argument("--net", default=None, help="shape the responses: none, 300mbit (300 Mbit/s, 20 ms), 50mbit (50 Mbit/s, 40 ms), "
                        "10mbit (10 Mbit/s, 80 ms) or <Mbit>/<round trip ms> (also <Mbit>:<round trip ms>)")
    parser.add_argument("--exit-after-session", type=float, default=None, metavar="SECONDS",
                        help="exit 0 this many seconds after the last ?ue-session=1 page closed (UAT's -run)")
    parser.add_argument("--game-run", action="store_true",
                        help="print the ?ue-session=1 page's console lines (UAT's client output) and exit with the game's "
                        "code when it ends (UAT's -run)")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="also answer requests for this host name (IP addresses, localhost and this computer's names "
                        "are always answered; any other name is refused, against DNS rebinding)")
    parser.add_argument("--serve-any-file", action="store_true",
                        help="in a stage, also serve files its .json lists do not name (dotfiles, raw .br files and the "
                        "--log-json file stay refused)")
    parser.add_argument("--open", default=None, metavar="PAGE",
                        help="open this page (relative to the root, e.g. 'index.html?ue-session=1') in the default browser "
                        "once the server listens (a packaged build's Play_<Game> launcher)")
    args = parser.parse_args(argv)
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("--tls-cert and --tls-key go together")
    tls = None
    if args.tls_cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_2
        try:
            tls.load_cert_chain(args.tls_cert, args.tls_key)
        except (OSError, ssl.SSLError) as error:
            print(f"serve: cannot load --tls-cert/--tls-key: {error}", file=sys.stderr)
            return 2
    root = os.path.abspath(args.root)
    shaping = parse_net(args.net)
    if shaping:
        Handler.shaper = Shaper(*shaping)
    Handler.immutable = args.immutable
    Handler.allow_hosts = {name.strip().lower().rstrip(".") for name in args.allow_host if name.strip()}
    Handler.serve_any_file = args.serve_any_file
    Handler._own_names()  # look this computer's names up once, before any request waits on it
    if args.log_json:
        Handler.log_json = open(args.log_json, "a", encoding="utf-8")
        Handler.log_json_path = os.path.realpath(args.log_json)

    def factory(*handler_args, **handler_kwargs):
        return Handler(*handler_args, directory=root, **handler_kwargs)

    # --port-tries (a packaged build's Play_<Game> launcher): the page's data cache (sw.js: Cache Storage, its quota and its
    # service worker) belongs to the origin, port included, so a launcher on a free port each time (--port 0) downloaded the
    # whole game again on every launch. The launcher asks for its game's own port and, when that one is busy, the next few;
    # only when all are taken does the system pick one (that visit starts with an empty cache)
    server_class = TLSServer if tls is not None else StageServer
    server = None
    for candidate in range(args.port, args.port + max(1, args.port_tries)) if args.port else ():
        try:
            server = server_class((args.bind, candidate), factory)
            break
        except OSError as error:
            if args.port_tries <= 1:
                raise
            # this game already served there (a second launch while its first tab is open): open the page on that server,
            # if it tracks sessions and agrees to stay up for the page (it may be just about to stop after a closed tab)
            if args.open and tls is None and _serves_same_stage(args.bind, candidate, root, Handler.log_json_path) and _hold(args.bind, candidate):
                page = f"http://{'127.0.0.1' if args.bind in ('0.0.0.0', '') else args.bind}:{candidate}/{args.open.lstrip('/')}"
                print(f"serve: this game is already served on port {candidate}: opening {page}", flush=True)
                webbrowser.open(page)
                return 0
            print(f"serve: port {candidate} is busy ({error.strerror or error})", file=sys.stderr, flush=True)
    if server is None:
        if args.port:
            print(f"serve: ports {args.port}-{args.port + args.port_tries - 1} are busy: a free port, so the browser's copy of "
                  "the game from earlier visits is not used", file=sys.stderr, flush=True)
        server = server_class((args.bind, 0), factory)
    if tls is not None:
        server.tls = tls
    scheme = "https" if tls is not None else "http"
    port = server.server_address[1]   # the bound port: --port 0 lets the system pick a free one
    print(f"serve: {scheme}://{args.bind}:{port}/ from {root}" + (f", net {args.net}" if shaping else ""), flush=True)
    if args.open:
        host = "127.0.0.1" if args.bind in ("0.0.0.0", "") else args.bind
        page = f"{scheme}://{host}:{port}/{args.open.lstrip('/')}"
        print(f"serve: opening {page}", flush=True)
        # after serve_forever starts accepting; the socket already listens, so the browser's first request just queues
        threading.Timer(0.2, webbrowser.open, args=(page,)).start()
    if args.exit_after_session is not None:
        Handler.sessions = Sessions()
        grace = max(0.0, args.exit_after_session)

        def watch():
            while not Handler.sessions.expire(grace):
                time.sleep(0.25)
            print(f"serve: the page closed {grace:g} s ago: stopping", flush=True)
            server.shutdown()

        threading.Thread(target=watch, name="session-watch", daemon=True).start()
    if args.game_run:
        sys.stdout.reconfigure(errors="backslashreplace")  # the game's lines on a console that cannot show every character
        Handler.game = GameRun()

        def game_watch():
            Handler.game.ended.wait()
            print(f"serve: the game ended with code {Handler.game.code}: stopping", flush=True)
            server.shutdown()

        threading.Thread(target=game_watch, name="game-watch", daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return Handler.game.code if Handler.game is not None and Handler.game.code is not None else 0


if __name__ == "__main__":
    sys.exit(main())

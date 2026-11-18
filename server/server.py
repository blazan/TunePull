#!/usr/bin/env python3
"""
Local helper server for the "TunePull" Chrome extension.

The extension cannot decode audio or encode MP3 by itself, so it hands the track
off to this small program, which runs on your own machine and shells out to
`yt-dlp` (fetch + extract) and `ffmpeg` (encode to MP3). Results are written to a
temporary folder and streamed back to the browser.

Endpoints
    GET  /health          -> {version, tools}
    POST /download        -> {jobId}          body: {url|videoId, title, artist, album, quality}
    GET  /job/<id>        -> {state, stage, percent, filename, error}
    GET  /file/<id>       -> the finished .mp3

It binds to loopback only. A token is generated on first run and printed; paste
it into the extension's settings. Use --no-auth to turn that off.

Requires: Python 3.8+, yt-dlp, ffmpeg.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

VERSION = "1.0.1"
ALLOWED_QUALITIES = {"128", "192", "256", "320"}
MAX_BODY_BYTES = 64 * 1024
JOB_TTL_SECONDS = 60 * 60  # finished jobs are cleaned up after an hour

# ---------------------------------------------------------------------------
# Job registry
# ---------------------------------------------------------------------------


class Job:
    def __init__(self, job_id: str, suggested_name: str, directory: Path) -> None:
        self.id = job_id
        self.suggested_name = suggested_name
        self.dir = directory
        self.state = "queued"  # queued | running | done | error
        self.stage = "Queued"
        self.percent: float | None = None
        self.error: str | None = None
        self.path: Path | None = None
        self.finished_at: float | None = None

    def as_dict(self) -> dict:
        return {
            "jobId": self.id,
            "state": self.state,
            "stage": self.stage,
            "percent": self.percent,
            "filename": self.suggested_name,
            "error": self.error,
        }


class JobStore:
    def __init__(self, workdir: Path) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._workdir = workdir

    def create(self, suggested_name: str) -> Job:
        job_id = uuid.uuid4().hex
        directory = Path(tempfile.mkdtemp(prefix=f"job-{job_id[:8]}-", dir=self._workdir))
        job = Job(job_id, suggested_name, directory)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def sweep(self) -> None:
        """Delete files (and records) for jobs that finished a while ago."""
        now = time.time()
        with self._lock:
            stale = [
                job_id
                for job_id, job in self._jobs.items()
                if job.finished_at and now - job.finished_at > JOB_TTL_SECONDS
            ]
        for job_id in stale:
            self.remove(job_id)

    def remove(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job:
            shutil.rmtree(job.dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# External tool discovery
# ---------------------------------------------------------------------------


def find_executable(name: str) -> str | None:
    return shutil.which(name)


def find_yt_dlp() -> list[str] | None:
    """Return an argv prefix for yt-dlp, whether it is a binary or a module."""
    exe = find_executable("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401  (import just to test availability)
    except ImportError:
        return None
    return [sys.executable, "-m", "yt_dlp"]


def find_js_runtime() -> str | None:
    """Return the name of a JavaScript runtime yt-dlp can use, if any.

    yt-dlp shells out to one of these to solve YouTube's signature/n challenges.
    Without it, extraction still "works" but silently loses formats.
    """
    for name in ("deno", "bun", "node", "quickjs"):
        if find_executable(name):
            return name
    return None


# ---------------------------------------------------------------------------
# Download + conversion
# ---------------------------------------------------------------------------

PROGRESS_RE = re.compile(r"\[download\]\s+([\d.]+)%")


def build_target_url(payload: dict) -> str:
    video_id = str(payload.get("videoId") or "").strip()
    if re.fullmatch(r"[\w-]{11}", video_id):
        return f"https://www.youtube.com/watch?v={video_id}"

    url = str(payload.get("url") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and parsed.hostname in {
        "music.youtube.com",
        "www.youtube.com",
        "youtube.com",
        "m.youtube.com",
        "youtu.be",
    }:
        return url
    raise ValueError("Provide a YouTube / YouTube Music video id or URL")


def clean_name(value: str, fallback: str) -> str:
    value = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", str(value or ""))
    value = re.sub(r"\s+", " ", value).strip().strip(".")
    return value[:150] or fallback


def last_error(lines: list[str]) -> str:
    """Return yt-dlp's most useful error line so the user can see a reason."""
    for line in reversed(lines):
        if line.startswith("ERROR:"):
            message = line[len("ERROR:") :].strip()[:300]
            hint = error_hint(message)
            return f"{message} — {hint}" if hint else message
    return ""


# YouTube-side conditions that no amount of retrying or updating will fix. They are
# common on music videos (label/region licensing), so say so instead of leaving the
# user to think the helper server is broken.
_ERROR_HINTS = (
    (
        ("video unavailable", "this video is not available", "not available in your country"),
        "YouTube is blocking this video (rights or region). Another upload of the same "
        "song may work.",
    ),
    (
        ("private video",),
        "the uploader set this video to private.",
    ),
    (
        ("video has been removed", "no longer available"),
        "the video was deleted by the uploader.",
    ),
    (
        ("sign in to confirm", "confirm you're not a bot", "confirm you are not a bot"),
        "YouTube is asking for a sign-in; this server has no account. Try again later.",
    ),
    (
        ("age-restricted", "age restricted", "confirm your age", "inappropriate for some users"),
        "the video is age-restricted, which needs a signed-in account.",
    ),
    (
        ("premieres in", "upcoming"),
        "the video has not premiered yet.",
    ),
)


def error_hint(message: str) -> str:
    lowered = message.lower()
    for needles, hint in _ERROR_HINTS:
        if any(needle in lowered for needle in needles):
            return hint
    return ""


def suggested_filename(payload: dict) -> str:
    title = clean_name(payload.get("title"), "Unknown title")
    artist = clean_name(payload.get("artist"), "")
    stem = clean_name(f"{artist} - {title}" if artist else title, "audio")
    return f"{stem}.mp3"


def ascii_filename(name: str) -> str:
    """Best-effort ASCII version of a filename, for headers that cannot hold UTF-8.

    http.server encodes header values as latin-1, so anything outside it (emoji,
    CJK, …) raises UnicodeEncodeError and aborts the response mid-flight.
    """
    # Strip the ASCII control characters that would break the header syntax.
    printable = re.sub(r"[\x00-\x1f\x7f]", "", name)
    ascii_only = printable.encode("ascii", "replace").decode("ascii")
    # A title made entirely of non-ASCII characters degrades to "?.mp3"; prefer a
    # generic name over one the user cannot recognise.
    if not re.search(r"[A-Za-z0-9]", ascii_only):
        return "audio.mp3"
    return ascii_only


def content_disposition(name: str) -> str:
    """RFC 6266/5987 header carrying both an ASCII and a UTF-8 filename."""
    fallback = ascii_filename(name).replace("\\", "_").replace('"', "'")
    quoted = quote(name, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quoted}"


def run_job(job: Job, payload: dict, yt_dlp: list[str], ffmpeg: str) -> None:
    quality = str(payload.get("quality") or "320")
    if quality not in ALLOWED_QUALITIES:
        quality = "320"

    try:
        job.state = "running"
        target = build_target_url(payload)
        job_dir = job.dir
        job.path = job_dir / "output.mp3"

        command = [
            *yt_dlp,
            "--no-playlist",
            "--no-part",
            "--newline",
            "--no-warnings",
            "--ffmpeg-location",
            ffmpeg,
            "-f",
            "bestaudio/best",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            f"{quality}K",
            "-o",
            str(job_dir / "source.%(ext)s"),
            "--paths",
            f"temp:{job_dir}",
            target,
        ]

        job.stage = "Downloading audio"
        job.percent = 0.0
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        assert process.stdout is not None
        tail: list[str] = []
        for line in process.stdout:
            line = line.rstrip("\n")
            tail.append(line)
            if len(tail) > 40:
                del tail[0]
            match = PROGRESS_RE.search(line)
            if match:
                # Download is the bulk of the wall-clock time, so map it to 0-90%.
                job.percent = round(min(float(match.group(1)) * 0.9, 90.0), 1)
            elif "[ExtractAudio]" in line or "[ffmpeg]" in line:
                job.stage = "Encoding MP3"
                job.percent = 95.0

        code = process.wait()
        if code != 0:
            raise RuntimeError(last_error(tail) or f"yt-dlp exited with code {code}")

        produced = job_dir / "output.mp3"
        if not produced.exists():
            candidates = sorted(job_dir.glob("*.mp3"))
            if not candidates:
                raise RuntimeError("No MP3 file was produced")
            candidates[0].rename(produced)

        job.path = produced
        job.state = "done"
        job.stage = "Ready"
        job.percent = 100.0
    except Exception as exc:  # surface the message to the user
        job.state = "error"
        job.stage = "Failed"
        job.error = str(exc)
    finally:
        job.finished_at = time.time()


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = f"TunePull/{VERSION}"

    # populated by create_server
    store: JobStore
    token: str | None
    yt_dlp: list[str]
    ffmpeg: str
    js_runtime: str | None
    origin_allow: str

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers ----------------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.origin_allow)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, status: HTTPStatus, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        if not self.token:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer ") and secrets.compare_digest(header[7:], self.token):
            return True
        # Downloads triggered by the browser cannot set headers, so accept ?token=.
        query_token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        return bool(query_token) and secrets.compare_digest(query_token, self.token)

    def _require_auth(self) -> bool:
        if self._authorized():
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Missing or invalid access token"})
        return False

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request body")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/health":
            if not self._require_auth():
                return
            tools = []
            if self.yt_dlp:
                tools.append("yt-dlp")
            if self.ffmpeg:
                tools.append("ffmpeg")
            self._send_json(
                HTTPStatus.OK,
                {
                    "version": VERSION,
                    "tools": tools,
                    # Missing JS runtime is not fatal, but it makes downloads flaky.
                    "jsRuntime": self.js_runtime or "",
                    "authRequired": bool(self.token),
                },
            )
            return

        if path.startswith("/job/"):
            if not self._require_auth():
                return
            job = self.store.get(path[len("/job/") :])
            if not job:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown job"})
                return
            self._send_json(HTTPStatus.OK, job.as_dict())
            return

        if path.startswith("/file/"):
            if not self._require_auth():
                return
            self._serve_file(path[len("/file/") :])
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/download":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        if not self._require_auth():
            return

        try:
            payload = self._read_json()
            build_target_url(payload)  # validate before creating a job
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        if not self.yt_dlp or not self.ffmpeg:
            missing = [
                name
                for name, found in (("yt-dlp", self.yt_dlp), ("ffmpeg", self.ffmpeg))
                if not found
            ]
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": f"Helper server is missing: {', '.join(missing)}"},
            )
            return

        self.store.sweep()
        job = self.store.create(suggested_filename(payload))
        threading.Thread(
            target=run_job,
            args=(job, payload, self.yt_dlp, self.ffmpeg),
            daemon=True,
        ).start()
        self._send_json(HTTPStatus.ACCEPTED, {"jobId": job.id, "filename": job.suggested_name})

    # -- file streaming ---------------------------------------------------

    def _serve_file(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if not job or job.state != "done" or not job.path or not job.path.exists():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "File is not ready"})
            return

        size = job.path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", content_disposition(job.suggested_name))
        # Custom headers are encoded latin-1 by http.server, so keep this ASCII.
        self.send_header("X-Suggested-Filename", ascii_filename(job.suggested_name))
        self._cors()
        self.end_headers()
        with job.path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile, length=64 * 1024)


def create_server(args: argparse.Namespace) -> tuple[ThreadingHTTPServer, JobStore]:
    workdir = Path(tempfile.mkdtemp(prefix="tunepull-"))
    store = JobStore(workdir)

    handler = type("BoundHandler", (Handler,), {})
    handler.store = store
    handler.token = None if args.no_auth else (args.token or secrets.token_urlsafe(24))
    handler.yt_dlp = find_yt_dlp()
    handler.ffmpeg = find_executable("ffmpeg") or ""
    handler.js_runtime = find_js_runtime()
    handler.origin_allow = args.origin or "*"

    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    return server, store


def main() -> int:
    parser = argparse.ArgumentParser(description="Helper server for the TunePull extension.")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8756, help="port (default: 8756)")
    parser.add_argument("--token", default="", help="fixed access token (default: random)")
    parser.add_argument("--no-auth", action="store_true", help="disable the access token")
    parser.add_argument(
        "--origin",
        default="*",
        help="value for Access-Control-Allow-Origin (default: *)",
    )
    args = parser.parse_args()

    server, store = create_server(args)
    handler = server.RequestHandlerClass

    missing = []
    if not handler.yt_dlp:
        missing.append("yt-dlp")
    if not handler.ffmpeg:
        missing.append("ffmpeg")

    print(f"TunePull helper server v{VERSION}")
    print(f"  listening on http://{args.host}:{args.port}")
    if missing:
        print(f"  !! missing tools: {', '.join(missing)} (downloads will fail until installed)")
    if not handler.js_runtime:
        print(
            "  !! no JavaScript runtime (deno/node/bun) found: YouTube extraction may\n"
            "     miss formats. Install deno and restart. yt-dlp-ejs is also recommended."
        )
    else:
        print(f"  javascript runtime: {handler.js_runtime}")
    if handler.token:
        print(f"  access token: {handler.token}")
        print("  -> paste this into the extension's settings page")
    else:
        print("  auth disabled (--no-auth)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()
        shutil.rmtree(store._workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

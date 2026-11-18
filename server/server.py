#!/usr/bin/env python3
"""
Local helper server for the "TunePull" Chrome extension.

The extension cannot decode audio or encode MP3 by itself, so it hands the track
off to this small program, which runs on your own machine and shells out to
`yt-dlp` (fetch + extract) and `ffmpeg` (encode to MP3, or merge to MP4). Results
are written to a temporary folder and streamed back to the browser.

Endpoints
    GET  /health          -> {version, tools}
    POST /download        -> {jobId}          body: {url|videoId, title, artist, album,
                                              mediaType, quality, videoQuality}
    GET  /job/<id>        -> {state, stage, percent, filename, error}
    POST /cancel/<id>     -> stop a running job
    GET  /file/<id>       -> the finished .mp3 or .mp4

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
import signal
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

VERSION = "1.2.0"
ALLOWED_QUALITIES = {"128", "192", "256", "320"}
# Video height caps; "best" means no cap. Anything else falls back to "best".
ALLOWED_VIDEO_HEIGHTS = {"best", "2160", "1440", "1080", "720", "480", "360"}
MAX_BODY_BYTES = 64 * 1024
JOB_TTL_SECONDS = 60 * 60  # finished jobs are cleaned up after an hour

AUDIO_EXT = "mp3"
VIDEO_EXT = "mp4"
CONTENT_TYPES = {"mp3": "audio/mpeg", "mp4": "video/mp4"}


class JobCancelled(Exception):
    """Raised inside run_job when the user cancels a download."""


def terminate_process(process: subprocess.Popen | None) -> None:
    """Stop yt-dlp and the ffmpeg it spawned, then reap them."""
    if process is None or process.poll() is not None:
        return
    try:
        # start_new_session put the child in its own group, so this reaches ffmpeg too.
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            process.kill()
        process.wait(timeout=5)


# ---------------------------------------------------------------------------
# Job registry
# ---------------------------------------------------------------------------


class Job:
    def __init__(self, job_id: str, suggested_name: str, directory: Path) -> None:
        self.id = job_id
        self.suggested_name = suggested_name
        self.dir = directory
        self.state = "queued"  # queued | running | done | error | cancelled
        self.stage = "Queued"
        self.percent: float | None = None
        self.error: str | None = None
        self.path: Path | None = None
        self.finished_at: float | None = None
        # The yt-dlp child, so a cancel or a shutdown can stop it.
        self.process: subprocess.Popen | None = None
        self.cancelled = False

    def as_dict(self) -> dict:
        return {
            "jobId": self.id,
            "state": self.state,
            "stage": self.stage,
            "percent": self.percent,
            "filename": self.suggested_name,
            "error": self.error,
            "cancelled": self.cancelled,
        }


class JobStore:
    def __init__(self, workdir: Path, max_jobs: int = 3) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._workdir = workdir
        # Caps concurrent yt-dlp/ffmpeg processes, so a burst of clicks cannot
        # swamp a Raspberry Pi. Extra jobs wait as "Queued" until a slot frees.
        self._slots = threading.BoundedSemaphore(max(1, max_jobs))

    def acquire_slot(self, timeout: float | None = None) -> bool:
        return self._slots.acquire(timeout=timeout)

    def release_slot(self) -> None:
        self._slots.release()

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

    def cancel(self, job_id: str) -> Job | None:
        """Stop a running job. Returns the job, or None if it is unknown."""
        job = self.get(job_id)
        if job is None:
            return None
        job.cancelled = True
        # Kill off the request thread: SIGTERM needs a grace period before SIGKILL,
        # and the caller (the extension) should not wait for that.
        threading.Thread(
            target=terminate_process, args=(job.process,), daemon=True
        ).start()
        return job

    def cancel_all(self) -> None:
        """Stop every running job (used on shutdown, so ffmpeg is not orphaned)."""
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            if job.finished_at is None:
                job.cancelled = True
                terminate_process(job.process)

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
            terminate_process(job.process)
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


def build_cookie_args(cookies: str, cookies_from_browser: str) -> list[str]:
    """yt-dlp arguments that authenticate the request.

    YouTube shows "Sign in to confirm you're not a bot" for many videos, and more
    often for datacenter IPs (a Pi behind a VPN, a rented server). Passing a
    logged-in browser's cookies clears it. Both flags are optional and mutually
    exclusive; a cookies file wins if both are given.
    """
    cookies = (cookies or "").strip()
    if cookies:
        return ["--cookies", cookies]
    browser = (cookies_from_browser or "").strip()
    if browser:
        return ["--cookies-from-browser", browser]
    return []


# ---------------------------------------------------------------------------
# Download + conversion
# ---------------------------------------------------------------------------

PROGRESS_RE = re.compile(r"\[download\]\s+([\d.]+)%")


def is_video(payload: dict) -> bool:
    return str(payload.get("mediaType") or "audio").strip().lower() == "video"


def media_ext(payload: dict) -> str:
    return VIDEO_EXT if is_video(payload) else AUDIO_EXT


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
        "YouTube is asking for a sign-in to prove this is not a bot. Give the helper "
        "server cookies (--cookies or --cookies-from-browser; see the README).",
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
    stem = clean_name(f"{artist} - {title}" if artist else title, "media")
    return f"{stem}.{media_ext(payload)}"


def ascii_filename(name: str) -> str:
    """Best-effort ASCII version of a filename, for headers that cannot hold UTF-8.

    http.server encodes header values as latin-1, so anything outside it (emoji,
    CJK, …) raises UnicodeEncodeError and aborts the response mid-flight.
    """
    # Strip the ASCII control characters that would break the header syntax.
    printable = re.sub(r"[\x00-\x1f\x7f]", "", name)
    ascii_only = printable.encode("ascii", "replace").decode("ascii")
    # A title made entirely of non-ASCII characters degrades to "?.mp4"; prefer a
    # generic name over one the user cannot recognise. Ignore the extension itself
    # when judging, or "?.mp4" would look like it has readable characters.
    stem = Path(ascii_only).stem
    if not re.search(r"[A-Za-z0-9]", stem):
        suffix = Path(name).suffix.lower()
        return f"media{suffix}" if suffix in (".mp3", ".mp4") else "media"
    return ascii_only


def content_disposition(name: str) -> str:
    """RFC 6266/5987 header carrying both an ASCII and a UTF-8 filename."""
    fallback = ascii_filename(name).replace("\\", "_").replace('"', "'")
    quoted = quote(name, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quoted}"


def run_job(
    job: Job,
    payload: dict,
    yt_dlp: list[str],
    ffmpeg: str,
    store: JobStore,
    cookie_args: list[str] | None = None,
) -> None:
    video = is_video(payload)
    quality = str(payload.get("quality") or "320")
    if quality not in ALLOWED_QUALITIES:
        quality = "320"
    height = str(payload.get("videoQuality") or "best")
    if height not in ALLOWED_VIDEO_HEIGHTS:
        height = "best"
    cookie_args = cookie_args or []

    try:
        # Wait for a free slot without blocking a cancel: a queued job must still be
        # stoppable, so poll the flag rather than sitting on the semaphore.
        while not store.acquire_slot(timeout=0.2):
            if job.cancelled:
                raise JobCancelled()

        try:
            _run_job_inner(job, payload, yt_dlp, ffmpeg, quality, height, video, cookie_args)
        finally:
            store.release_slot()
    except JobCancelled:
        job.state = "cancelled"
        job.stage = "Cancelled"
        job.error = "Cancelled"
    except Exception as exc:  # surface the message to the user
        job.state = "error"
        job.stage = "Failed"
        job.error = str(exc)
    finally:
        job.process = None
        job.finished_at = time.time()


def _run_job_inner(
    job: Job,
    payload: dict,
    yt_dlp: list[str],
    ffmpeg: str,
    quality: str,
    height: str,
    video: bool,
    cookie_args: list[str],
) -> None:
    job.state = "running"
    target = build_target_url(payload)
    job_dir = job.dir
    ext = VIDEO_EXT if video else AUDIO_EXT
    job.path = job_dir / f"output.{ext}"

    if video:
        # Prefer an H.264+AAC mp4 so the file plays anywhere without remuxing.
        fmt = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        if height != "best":
            fmt = f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}]/best"
        command = [
            *yt_dlp,
            "--no-playlist",
            "--no-part",
            "--newline",
            "--no-warnings",
            "--ffmpeg-location",
            ffmpeg,
            *cookie_args,
            "-f",
            fmt,
            "--merge-output-format",
            "mp4",
            "-o",
            str(job_dir / "source.%(ext)s"),
            "--paths",
            f"temp:{job_dir}",
            target,
        ]
        stage_download = "Downloading video"
        stage_encode = "Merging video"
    else:
        command = [
            *yt_dlp,
            "--no-playlist",
            "--no-part",
            "--newline",
            "--no-warnings",
            "--ffmpeg-location",
            ffmpeg,
            *cookie_args,
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
        stage_download = "Downloading audio"
        stage_encode = "Encoding MP3"

    job.stage = stage_download
    job.percent = 0.0
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        # Own process group, so a cancel can take ffmpeg (yt-dlp's child) with it.
        start_new_session=True,
    )
    job.process = process

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
        elif "[ExtractAudio]" in line or "[Merger]" in line or "[ffmpeg]" in line:
            # ffmpeg re-encodes/merges the whole track here; on a multi-hour file
            # this is minutes of wall time with no further progress output.
            job.stage = stage_encode
            job.percent = 95.0

    code = process.wait()
    if process.stdout:
        process.stdout.close()
    if job.cancelled:
        raise JobCancelled()
    if code != 0:
        raise RuntimeError(last_error(tail) or f"yt-dlp exited with code {code}")

    produced = job_dir / f"output.{ext}"
    if not produced.exists():
        candidates = sorted(job_dir.glob(f"*.{ext}"))
        if not candidates:
            raise RuntimeError(f"No {ext.upper()} file was produced")
        candidates[0].rename(produced)

    job.path = produced
    job.state = "done"
    job.stage = "Ready"
    job.percent = 100.0


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
    cookie_args: list[str]

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
                    "cookies": bool(self.cookie_args),
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

        if path.startswith("/cancel/"):
            if not self._require_auth():
                return
            job = self.store.cancel(path[len("/cancel/") :])
            if not job:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown job"})
                return
            self._send_json(HTTPStatus.OK, job.as_dict())
            return

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
            args=(job, payload, self.yt_dlp, self.ffmpeg, self.store, self.cookie_args),
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
        suffix = job.path.suffix.lower().lstrip(".")
        content_type = CONTENT_TYPES.get(suffix, "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
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
    store = JobStore(workdir, max_jobs=getattr(args, "max_jobs", 3))

    handler = type("BoundHandler", (Handler,), {})
    handler.store = store
    handler.token = None if args.no_auth else (args.token or secrets.token_urlsafe(24))
    handler.yt_dlp = find_yt_dlp()
    handler.ffmpeg = find_executable("ffmpeg") or ""
    handler.js_runtime = find_js_runtime()
    handler.origin_allow = args.origin or "*"
    handler.cookie_args = build_cookie_args(
        getattr(args, "cookies", ""), getattr(args, "cookies_from_browser", "")
    )

    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    return server, store


def main() -> int:
    parser = argparse.ArgumentParser(description="Helper server for the TunePull extension.")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8756, help="port (default: 8756)")
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=3,
        help="how many downloads may run at once (default: 3)",
    )
    parser.add_argument("--token", default="", help="fixed access token (default: random)")
    parser.add_argument("--no-auth", action="store_true", help="disable the access token")
    parser.add_argument(
        "--cookies",
        default="",
        help="path to a Netscape cookies.txt so yt-dlp can sign in (fixes the "
        "\"confirm you're not a bot\" wall)",
    )
    parser.add_argument(
        "--cookies-from-browser",
        default="",
        dest="cookies_from_browser",
        help="read cookies from a local browser instead, e.g. firefox or chrome "
        "(needs that browser's profile on this machine)",
    )
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
    if handler.cookie_args:
        print(f"  cookies: {handler.cookie_args[-1]} (YouTube sign-in enabled)")
    else:
        print(
            "  cookies: none — YouTube may show \"confirm you're not a bot\". Pass\n"
            "     --cookies <file> or --cookies-from-browser <browser> if that happens."
        )
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
        # Kill any in-flight yt-dlp/ffmpeg before the workdir goes away, so a long
        # encode cannot keep running (and writing) after the server has exited.
        store.cancel_all()
        server.server_close()
        shutil.rmtree(store._workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

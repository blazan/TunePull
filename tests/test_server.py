#!/usr/bin/env python3
"""Server tests: the filename headers and a full download round-trip.

    python3 tests/test_server.py

Uses fake `yt-dlp`/`ffmpeg` executables (see AGENTS.md), so no network and no
real encoding are involved. Standard library only.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "server"))

import server  # noqa: E402


FAKE_YT_DLP = """#!/usr/bin/env python3
import os, sys

argv = sys.argv[1:]
out = None
for i, arg in enumerate(argv):
    if arg == "-o":
        out = argv[i + 1]
if out:
    path = out.replace("%(ext)s", "mp3")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"ID3\\x03\\x00\\x00\\x00" + b"\\x00" * 512)
print("[download] 100% of 0.50KiB")
print("[ExtractAudio] Destination: " + (path if out else "unknown"))
"""


def make_fakes(directory: Path) -> None:
    for name in ("yt-dlp", "ffmpeg"):
        path = directory / name
        path.write_text(FAKE_YT_DLP)
        path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


class FilenameHeaderTests(unittest.TestCase):
    """The header helpers must never emit a byte outside latin-1."""

    def test_ascii_filename_strips_non_ascii(self) -> None:
        result = server.ascii_filename("Artíst - Song 🎵 日本.mp3")
        self.assertTrue(result.isascii(), result)
        self.assertTrue(result.endswith(".mp3"))
        self.assertNotIn("\n", result)

    def test_ascii_filename_removes_control_characters(self) -> None:
        self.assertNotIn("\r", server.ascii_filename("bad\r\nname.mp3"))

    def test_ascii_filename_never_empty(self) -> None:
        self.assertEqual(server.ascii_filename("🎵"), "audio.mp3")

    def test_content_disposition_is_latin1_safe(self) -> None:
        # http.server encodes headers as latin-1; a stray emoji aborts the response.
        header = server.content_disposition("Artíst - Song 🎵 日本.mp3")
        header.encode("latin-1")  # raises if the fix regresses

    def test_content_disposition_carries_utf8_and_fallback(self) -> None:
        header = server.content_disposition("Ünïcode 日本.mp3")
        self.assertIn("filename*=UTF-8''", header)
        self.assertIn("filename=", header)
        self.assertIn("%E6%97%A5%E6%9C%AC", header)  # 日本, percent-encoded

    def test_content_disposition_escapes_quotes(self) -> None:
        header = server.content_disposition('a "quoted" name.mp3')
        fallback = header.split("filename=", 1)[1].split(";", 1)[0]
        self.assertNotIn('"', fallback.strip('"'))


class ErrorHintTests(unittest.TestCase):
    """YouTube-side failures get a plain-language hint appended."""

    def test_video_unavailable_explained(self) -> None:
        hint = server.error_hint("Video unavailable. This video is not available")
        self.assertIn("rights or region", hint)

    def test_private_video_explained(self) -> None:
        self.assertIn("private", server.error_hint("Private video. Sign in if you've been granted access"))

    def test_unknown_error_has_no_hint(self) -> None:
        self.assertEqual(server.error_hint("HTTP Error 500: Internal Server Error"), "")

    def test_hint_is_appended_to_last_error(self) -> None:
        lines = ["[download] 10%", "ERROR: [youtube] abc: Video unavailable"]
        message = server.last_error(lines)
        self.assertIn("Video unavailable", message)
        self.assertIn("rights or region", message)

    def test_plain_error_unchanged(self) -> None:
        self.assertEqual(server.last_error(["ERROR: something odd"]), "something odd")


class DownloadRoundTripTests(unittest.TestCase):
    """Serve a finished job whose title is non-ASCII — the reported crash."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        fake_bin = Path(cls.tmp.name) / "bin"
        fake_bin.mkdir()
        make_fakes(fake_bin)

        cls._old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{fake_bin}{os.pathsep}{cls._old_path}"

        args = server.argparse.Namespace(
            host="127.0.0.1", port=0, token="", no_auth=True, origin="*"
        )
        cls.httpd, cls.store = server.create_server(args)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.environ["PATH"] = cls._old_path
        cls.tmp.cleanup()

    def _post(self, payload: dict) -> str:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/download",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 202)
            return json.load(response)["jobId"]

    def _wait(self, job_id: str, timeout: float = 20.0) -> dict:
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/job/{job_id}", timeout=10
            ) as response:
                status = json.load(response)
            if status["state"] in ("done", "error"):
                return status
            time.sleep(0.1)
        self.fail("job did not finish in time")

    def test_unicode_title_downloads(self) -> None:
        job_id = self._post(
            {
                "videoId": "dQw4w9WgXcQ",
                "title": "Song 🎵 日本 Ünïcode",
                "artist": "Artíst",
            }
        )
        status = self._wait(job_id)
        self.assertEqual(status["state"], "done", status.get("error"))

        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/file/{job_id}", timeout=10
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Content-Type"], "audio/mpeg")
            disposition = response.headers["Content-Disposition"]
            self.assertIn("filename*=UTF-8''", disposition)
            self.assertTrue(response.headers["X-Suggested-Filename"].isascii())
            self.assertGreater(len(response.read()), 0)

    def test_rejects_unknown_host(self) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/download",
            data=json.dumps({"url": "https://example.com/watch?v=x"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(ctx.exception.code, 400)

    def test_health_reports_js_runtime(self) -> None:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/health", timeout=10
        ) as response:
            body = json.load(response)
        self.assertEqual(body["version"], server.VERSION)
        self.assertIn("yt-dlp", body["tools"])
        self.assertIn("jsRuntime", body)  # "" when absent, runtime name otherwise


class JsRuntimeDetectionTests(unittest.TestCase):
    def test_detects_deno_when_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            deno = Path(tmp) / "deno"
            deno.write_text("#!/bin/sh\nexit 0\n")
            deno.chmod(0o755)
            old = os.environ["PATH"]
            os.environ["PATH"] = f"{tmp}{os.pathsep}{old}"
            try:
                self.assertEqual(server.find_js_runtime(), "deno")
            finally:
                os.environ["PATH"] = old

    def test_returns_none_when_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ["PATH"]
            os.environ["PATH"] = tmp
            try:
                self.assertIsNone(server.find_js_runtime())
            finally:
                os.environ["PATH"] = old


if __name__ == "__main__":
    unittest.main(verbosity=2)

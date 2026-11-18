# AGENTS.md

Repo memory for the "TunePull" Chrome extension.

## What this is

An MV3 Chrome extension (`extension/`) plus a stdlib-only Python helper server
(`server/server.py`). The extension scrapes the playing track and asks the
server to run `yt-dlp` + `ffmpeg`, which produces the MP3 and streams it back.

There is **no popup**: clicking the toolbar icon (or `Alt+Shift+D`) runs the whole
flow in the service worker, and all configuration lives on the options page.

## Commands

```bash
python server/server.py                 # run the helper server (default :8756)
python server/server.py --no-auth       # quick local testing without a token
python tools/make_icons.py              # regenerate extension/icons/*.png
python -m py_compile server/server.py   # syntax check
node --check extension/background.js    # syntax check (any extension JS file)
python3 tests/test_server.py            # helper-server tests (fake yt-dlp/ffmpeg)
```

## Conventions and gotchas

* The extension only sends track data to hosts the user trusts: loopback always,
  plus anything listed in the `trustedHosts` setting. `isTrustedHost` in
  `extension/lib/config.js` is the single source of truth, used by both
  `background.js` and `options.js`. Keep it as the only place that decides.
* MV3 service workers have no `URL.createObjectURL`, so downloads point
  `chrome.downloads` at the server's `/file/<id>` URL instead of a blob.
* Browser downloads cannot set headers, so the server also accepts the bearer
  token as a `?token=` query parameter on `/file/...`.
* No runtime dependencies beyond `yt-dlp` and `ffmpeg` on PATH. Keep the server
  standard-library only.
* The extension message API between the options page and the service worker is
  only `tunepull:ping` (connection test) and `tunepull:getTrack`. The download itself is
  driven by `chrome.action.onClicked` inside the service worker, not by messages.
* The service worker keeps the badge updated on every poll tick; that is also what
  keeps it alive across a long conversion. Do not remove those badge updates.
* `buildDownloadPath` must stay the only place that builds a `chrome.downloads`
  filename: it strips `..` and absolute paths, which the downloads API rejects.
* `chrome.downloads` writes relative to the browser's Downloads directory, so the
  user's "folder" setting is a relative path, never absolute.
* `http.server` encodes header values as **latin-1**. Any filename that reaches a
  header must go through `ascii_filename` / `content_disposition`; a raw emoji or CJK
  character raises `UnicodeEncodeError` *after* the status line is sent, so the
  response aborts mid-transfer and the browser reports a broken connection. This was
  the cause of the "Check your internet connection" reports.
* yt-dlp needs a JS runtime (`deno`) plus `yt-dlp-ejs` to solve YouTube's signature
  and `n` challenges. Without them it only warns, then silently drops formats, so
  failures look random. The image bundles both; keep them when editing the Dockerfile.
* `last_error` appends a plain-language `error_hint` for YouTube-side conditions
  (unavailable/private/region/age). Add new patterns to `_ERROR_HINTS` rather than
  matching in the extension, so the logic stays in one place and is unit-tested.
* Jobs run **concurrently**, not queued one at a time: each `POST /download` spawns a
  daemon thread, and `JobStore`'s `BoundedSemaphore` (`--max-jobs`, default 3) caps how
  many yt-dlp/ffmpeg processes run at once; extra jobs wait as `state="queued"`. A queued
  job polls the semaphore with a timeout so it stays cancellable while it waits.
* Cancel is a two-part contract. The extension cancels by POSTing `/cancel/<id>`, which
  sets `job.cancelled` and SIGKILLs the child's process group (yt-dlp *and* its ffmpeg
  child, via `start_new_session=True`). `run_job` then sees the flag and settles the job
  as `state="cancelled"`. Once the file is transferring, the extension instead calls
  `chrome.downloads.cancel` — the server has nothing left to do. Both paths are silent
  (`CancelledError`, no failure notification).
* Progress is a coarse model: download maps 0–100% onto 0–90, and the ffmpeg re-encode
  pins the bar at `95%` with no further output. A multi-hour mix legitimately sits at
  `95%` for minutes; that is why cancel matters more than a better percentage.

## Docker / remote host

* `Dockerfile` + `docker-compose.yml` run the server on another machine (e.g. a
  Raspberry Pi). The container binds `0.0.0.0` (required for the port to be
  reachable) and always sets a token.
* The image is published multi-arch to Docker Hub as `tunepull-server`
  (`linux/amd64` + `linux/arm64`), so a Pi pulls it without building. `docker-compose.yml`
  references the published image, not `build: .`.
* Push a new build with:
  `docker buildx build --platform linux/amd64,linux/arm64 -t <user>/tunepull-server:latest --push .`
  (buildkit bundles QEMU, so arm64 builds work from an amd64 host).
* The `HEALTHCHECK` probes the TCP port, not `/health`, because `/health` requires
  the token and a container healthcheck should not need the secret.
* `COPY --chown=appuser:appuser` is deliberate: the build environment's umask can
  produce mode `600`, and the image runs as a non-root user that must read the file.
* The `deno` binary is copied from `denoland/deno:bin-2.9.8` (multi-arch) in a build
  stage — deliberately not `curl | sh`, so the build stays reproducible and offline-safe
  apart from the base images.
* Client side: set Server URL to `http://<pi-ip>:8756` and add the host under
  Trusted hosts. Saving the URL auto-adds the hostname.

```bash
docker run -d -p 8756:8756 <user>/tunepull-server:latest --token <secret>
TUNEPULL_TOKEN=<secret> docker compose up -d      # pulls the published image
docker compose pull && docker compose up -d       # update later
```

## Previewing the UI

`preview/` renders the real options page against a mocked `chrome.*` API, so the
UI can be clicked through in a plain browser. `preview/index.html` and
`preview/mock.js` are hand-written; the rest of `preview/` is generated by
`python tools/make_preview.py` (and is gitignored). The one-click flow cannot run
in a plain page (no service worker, no action badge), so `index.html` recreates
the badge and notification by hand — keep it in step with `background.js` when
the flow changes. Faking `chrome.*` is fine here because the preview tests
rendering only — never point it at real downloads.

## Tests

`node --test "tests/*.test.mjs"` covers the pure helpers in
`extension/lib/config.js` (templates, path building, host trust) and drives
`extension/background.js` end to end against mocked `chrome.*` + `fetch`
(`tests/background.test.mjs`). The mock reports download completion via
`chrome.downloads.onChanged`, because `chrome.downloads.download()` resolves when
the transfer *starts* — code must not treat that as success. Keep `config.js` free
of `chrome.*` at import time so the helper tests stay runnable.

`python3 tests/test_server.py` covers the helper server: the filename-header
helpers, the YouTube error hints, a full `POST /download` → poll → `/file/<id>`
round-trip, and the concurrency/cancel contract (two jobs overlap, `/cancel` stops a
running job, `--max-jobs` queues extras, and a queued job can be cancelled). It puts
fake `yt-dlp`/`ffmpeg` on `PATH`, so it needs no network and no real encoding — the
`make_slow_fakes` variant sleeps so overlap is observable. Run both suites before pushing.

## Testing without network

Put fake `yt-dlp` / `ffmpeg` executables on `PATH` that print yt-dlp-style
progress lines and write a dummy MP3 to the `-o` template path, then drive the
server with `curl` (`/health`, `POST /download`, `/job/<id>`, `/file/<id>`).

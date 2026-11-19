# AGENTS.md

Repo memory for the "TunePull" Chrome extension.

## What this is

An MV3 Chrome extension (`extension/`) plus a stdlib-only Python helper server
(`server/server.py`). The extension scrapes the playing track and asks the
server to run `yt-dlp` + `ffmpeg`, which produces the MP3 (or MP4) and streams it back.

There is **no popup**: clicking the toolbar icon (or `Alt+Shift+D`) runs the whole
flow in the service worker, and all configuration lives on the options page.

The `mediaType` setting (`"audio"` | `"video"`) picks what a click produces. It is
sent in the `POST /download` body; the server branches on it (`is_video`) to choose the
yt-dlp args, the output extension, and the `/file/<id>` content type. Audio and video
keep **separate** folder/template settings in `config.js` (`mediaSettings` resolves the
right pair), so switching mode never overwrites the other's choices. Video downloads
use `-f bestvideo[ext=mp4]+bestaudio[ext=m4a]/…` with `--merge-output-format mp4`
(capped by `videoQuality`, a height); audio keeps the existing extract-to-MP3 path.

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
* YouTube's **"Sign in to confirm you're not a bot"** wall (and the `403` that follows)
  is cleared only by cookies. There are two sources, resolved per request by
  `Handler._cookie_args()`: an operator flag (`--cookies <file>` /
  `--cookies-from-browser <browser>`, parsed once by `build_cookie_args` into
  `cookie_args`) wins; otherwise the cookies the extension uploaded to `POST /cookies`,
  held by `CookieStore`. Either way the args are threaded through `run_job` →
  `_run_job_inner` into both the audio and video command lists. It is stricter for
  datacenter IPs, which is why a VPS or a Pi behind a VPN hits it constantly and a home
  connection often does not. The fix is cookies or a fresher yt-dlp, never a retry loop;
  the error hint says so.
* Extension-uploaded cookies are **credentials**, so `CookieStore` is deliberately
  defensive: `normalize_cookies` validates the Netscape format (rejecting junk before
  anything is written), the file is written `0600` via `os.replace` (atomic, so a running
  job never reads a half-written file) inside the server's private temp workdir, and it
  lives only for the process — restart wipes it. Never log or echo the values back;
  `POST /cookies` replies with a count only. The extension sends **only auth cookies**
  (`SID`, `HSID`, `__Secure-*`, …) from `lib/cookies.js`, gated by the opt-in
  `syncCookies` setting and the same trusted-host check as every other request.
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
  `95%` for minutes; that is why cancel matters more than a better percentage. Video
  mode shares this model: the ffmpeg merge (yt-dlp's `[Merger]` line) is the `95%` stage.
* The media type is chosen **once, in the settings**, never per download. The extension
  must not prompt or infer it from the page. `mediaSettings` in `config.js` is the single
  place that maps the `mediaType` setting to a folder/template/extension; `buildDownloadPath`
  takes the extension so the saved name matches the server's file.
* **The toolbar tooltip must follow `mediaType`.** A manifest `default_title` is static, so
  it can only ever name one format; the worker sets the real title via
  `chrome.action.setTitle` (`actionTitle()` in `config.js`) on startup, on install/startup,
  and whenever `storage.onChanged` reports a `mediaType` change. Never reintroduce a
  format-specific string in the manifest — it will lie in the other mode. The shortcut
  description cannot be changed at runtime, so it must stay format-neutral.
* **Right-clicking the toolbar icon switches format** (`contexts: ["action"]`), and that
  menu is the only per-download-ish control we allow: it writes the same `mediaType`
  setting the options page writes. It is a `radio` pair so it also shows the current
  mode. `contextMenus` must stay in `manifest.permissions` — without it the API is
  undefined and the menu silently never appears. Rebuilds are serialized with a
  generation counter because `removeAll` is async; two overlapping rebuilds would
  otherwise create duplicate ids.
* Anything that writes `mediaType` outside the options page must keep that page honest:
  `options.js` listens on `storage.onChanged` and re-renders, because its `save()`
  writes the *whole* form and would otherwise undo an outside change.
* **The saved file belongs to the PC, never the server.** The server's copy exists only
  to be streamed: `_serve_file` sets `job.delivered_at` once the bytes are handed to the
  socket, and `sweep()` deletes the file `DELIVERED_TTL_SECONDS` (5 min) later, with
  `JOB_TTL_SECONDS` (1 h) as the ceiling for a job nobody fetched. A sweeper thread in
  `create_server` runs every `SWEEP_INTERVAL_SECONDS` so an idle server still cleans up —
  do not make cleanup depend only on a new job arriving. Keep this behaviour when
  touching `JobStore`; the whole point of a Pi deployment is that it stores nothing.
* Jobs in `UNFETCHABLE_STATES` (`error`, `cancelled`) are swept on the short TTL too.
  They can never be served, so their partial downloads must not sit out the hour — a Pi
  that repeatedly hits the bot wall would otherwise fill its disk with failed attempts.
* `docker stop`/`restart` send SIGTERM. `main()` installs a SIGTERM handler that raises
  `KeyboardInterrupt`, so the `finally` block (kill children, `rmtree` the workdir) runs.
  Without it the process dies abruptly and leaves job files in `/tmp`.

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
* Never publish with a plain `docker build`/`docker push`: that produces an
  amd64-only image, and the Pi then fails to pull with "no matching manifest for
  linux/arm64". Always use the `buildx --platform linux/amd64,linux/arm64` form
  above, and confirm with
  `docker manifest inspect <user>/tunepull-server:latest | grep -A2 architecture`
  that both architectures are listed.
* The `HEALTHCHECK` probes the TCP port, not `/health`, because `/health` requires
  the token and a container healthcheck should not need the secret.
* `COPY --chown=appuser:appuser` is deliberate: the build environment's umask can
  produce mode `600`, and the image runs as a non-root user that must read the file.
* The `deno` binary is copied from `denoland/deno:bin-2.9.8` (multi-arch) in a build
  stage — deliberately not `curl | sh`, so the build stays reproducible and offline-safe
  apart from the base images.
* Client side: set Server URL to `http://<pi-ip>:8756` and add the host under
  Trusted hosts. Saving the URL auto-adds the hostname.
* Cookies for the bot wall have two paths. (1) **Bind mount** for a manual file: the
  compose file ships the volume + `--cookies` lines commented out because a cookies.txt
  is a credential and must never land in a layer. (2) **Extension upload** (`POST
  /cookies`): recommended when the browser and server are on different machines (Chrome
  on Windows, server on a Pi), since the Pi has no browser to read cookies from — the
  extension reads them on the PC and the server keeps them in memory only.

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
helpers, the media-type helpers (`is_video` / `media_ext` / `suggested_filename`), the
YouTube error hints, a full `POST /download` → poll → `/file/<id>` round-trip (audio
*and* video, checking the extension and `Content-Type`), and the concurrency/cancel
contract (two jobs overlap, `/cancel` stops a running job, `--max-jobs` queues extras,
and a queued job can be cancelled). It puts fake `yt-dlp`/`ffmpeg` on `PATH`, so it needs
no network and no real encoding — the fakes write an `.mp4` when they see
`--merge-output-format`, and the `make_slow_fakes` variant sleeps so overlap is
observable. Run both suites before pushing.

## Testing without network

Put fake `yt-dlp` / `ffmpeg` executables on `PATH` that print yt-dlp-style
progress lines and write a dummy MP3 (or MP4 in video mode) to the `-o` template
path, then drive the server with `curl` (`/health`, `POST /download`, `/job/<id>`,
`/file/<id>`).

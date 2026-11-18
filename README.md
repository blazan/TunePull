# TunePull

**One click on the toolbar icon downloads the song you are playing on YouTube Music (or YouTube) as an MP3 — or the whole video as an MP4.**

No popup, no per-song dialog. You configure the destination folder, quality and file
name once in the settings, and after that every download is a single click. A single
setting chooses whether a click saves **audio (MP3)** or **video (MP4)**.

```
┌────────────────────┐   track metadata   ┌──────────────────────┐
│  Chrome extension  │ ─────────────────► │  local helper server │
│  (icon + content)  │ ◄───────────────── │  yt-dlp + ffmpeg     │
└────────────────────┘   progress + file  └──────────────────────┘
                                           writes to a temp folder,
                                           streams the .mp3/.mp4 back
```

The extension cannot decode audio on its own, so the audio work happens in a small
helper server running on **your** machine. Nothing is uploaded to a third party —
the extension only ever talks to `127.0.0.1` (or a host you explicitly trust).

- [Features](#features)
- [Quick start](#quick-start)
- [Settings](#settings)
- [Run the helper server on a Raspberry Pi](#run-the-helper-server-on-a-raspberry-pi)
- [How it works](#how-it-works)
- [Safety and privacy](#safety-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Legal note](#legal-note)

---

## Features

- **One-click download.** Click the toolbar icon (or press `Alt+Shift+D`) — that is
  the whole action. No popup to fill in.
- **Global settings.** Folder, quality and file-name template are set once and apply
  to every download.
- **Choose where files land.** Save into any folder inside your Downloads directory,
  e.g. `Music/YouTube`. Subfolders are created automatically.
- **Flexible file names.** Use a template such as `{artist} - {title}`,
  `{artist} - {album} - {title}` or just `{title}`, with a live preview in settings.
- **Live progress on the icon.** The badge shows a percentage, then `✓` or `!`, and a
  desktop notification names the file that was saved.
- **Quality control.** Audio: 128 / 192 / 256 / 320 kbps. Video: best, or a height cap
  from 2160p down to 360p.
- **Audio or video.** A single setting decides whether a click saves an MP3 or an MP4.
  Audio and video keep separate folders and file names, so the two never collide.
- **Runs anywhere.** Keep the server on your laptop, or on a Raspberry Pi so the
  CPU-heavy encoding happens elsewhere. A prebuilt arm64/amd64 image is on Docker Hub.
- **Minimal footprint.** The server is Python standard library only — no pip install
  for the server itself.

## Quick start

### 1. Install the helper server

The server needs **Python 3.8+**, **yt-dlp** and **ffmpeg**.

```bash
# yt-dlp (any one of these)
pip install -U yt-dlp
#   brew install yt-dlp  |  winget install yt-dlp  |  scoop install yt-dlp

# ffmpeg
#   macOS:         brew install ffmpeg
#   Windows:       winget install Gyan.FFmpeg    (or: scoop install ffmpeg)
#   Debian/Ubuntu: sudo apt install ffmpeg
#   Fedora:        sudo dnf install ffmpeg
```

Then start it:

```bash
python server/server.py
```

You will see something like:

```
TunePull helper server v1.3.0
  listening on http://127.0.0.1:8756
  cookies: none yet — the extension can send them automatically, or pass
     --cookies <file> / --cookies-from-browser <browser>. YouTube may show
     "confirm you're not a bot" until cookies are supplied.
  access token: 5f3c...9a
  -> paste this into the extension's settings page
```

Keep this window open while you download. Useful flags:

| Flag | Meaning |
| --- | --- |
| `--port 8756` | Change the port (keep it in sync with the extension). |
| `--host 127.0.0.1` | Bind address. Leave it on loopback unless you know why. |
| `--max-jobs 3` | How many downloads run at once. Extra clicks queue and start as slots free. |
| `--token <value>` | Use a fixed token instead of a random one. |
| `--no-auth` | Disable the token entirely (only for a trusted machine). |
| `--cookies <file>` | A Netscape `cookies.txt` so yt-dlp can sign in. Fixes "confirm you're not a bot". |
| `--cookies-from-browser <browser>` | Read cookies from a local browser instead (e.g. `firefox`, `chrome`). |
| `--origin '*'` | Value for `Access-Control-Allow-Origin`. |

### 2. Install the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open the extension's **options** page — right-click the toolbar icon and choose
   *Options*, or use the *Extension options* link on `chrome://extensions` — then:
   - paste the **access token** printed by the server,
   - set the **folder** to save into (e.g. `Music/YouTube`),
   - pick the **quality** and the **file-name template**.

   Settings save as you change them, so there is nothing to submit.

### 3. Use it

1. Play a song on `music.youtube.com` (or a video on `youtube.com`).
2. **Click the toolbar icon** (or press `Alt+Shift+D`).
3. The icon shows progress; when it finishes you get a notification naming the saved
   file. Repeat downloads really are a single click.

Start as many songs as you like, one after another — you do not have to wait for one to
finish before starting the next. Each runs in its own job; the badge shows `+N` while
several are in flight, and each one notifies you when it is saved. The server runs up to
`--max-jobs` at once (3 by default); anything beyond that waits its turn as *Queued*.

To stop a download you no longer want, click the toolbar icon again **while the same
song is still downloading**. The first click starts it, the second click cancels it:
the server kills yt-dlp/ffmpeg, and if the file is already transferring, Chrome's
download is cancelled too. Cancelling is silent — no failure notification.

A note on long videos: a multi-hour DJ mix can take minutes to re-encode to MP3. The
progress sits at `95%` (the "Encoding MP3" stage) for that whole time; it is working, not
stuck. If you would rather not wait, click again to cancel.

### Audio or video

Under **What to download** you choose whether a click gives you an **MP3** (audio) or an
**MP4** (video). It is a single setting, decided before you download — there is still no
per-song dialog. The audio and video settings are kept separately, so switching modes
never overwrites the other's folder or file name.

In video mode the server asks yt-dlp for the best MP4 (H.264 + AAC where available) and
merges the streams with ffmpeg, capped at the height you picked. The merged file plays in
any player without remuxing. It takes longer than audio, since it downloads the video
track as well — the badge shows "Merging video" at `95%` while ffmpeg finishes.

## Settings

Everything lives on one page (right-click the toolbar icon → *Options*).

| Setting | Default | Notes |
| --- | --- | --- |
| **Server URL** | `http://127.0.0.1:8756` | The helper server. Must match its `--port`. |
| **Access token** | *(empty)* | The token printed by the server. |
| **Trusted hosts** | *(empty)* | Extra hostnames/IPs allowed beyond loopback. |
| **Download as** | Audio — MP3 | What every click saves: an MP3 or an MP4. |
| **Quality** (audio) | 320 kbps | 128 / 192 / 256 / 320. |
| **Save to folder** (audio) | `Music/YouTube` | Relative to your Downloads directory. Empty = Downloads itself. |
| **File name** (audio) | `{artist} - {title}` | Placeholders: `{title}`, `{artist}`, `{album}`. |
| **Quality** (video) | Best available | Best, or a height cap (2160p … 360p). |
| **Save to folder** (video) | *(empty)* | Videos get their own folder, so they do not mix with music. |
| **File name** (video) | `{artist} - {title}` | Same placeholders as audio. |
| **Ask me where to save each file** | off | Adds a Save-as dialog (breaks one-click). |
| **Show a notification when a download finishes** | on | Desktop notification with the saved path. |
| **Send my YouTube cookies to the helper server automatically** | off | Clears the bot wall. Sends account credentials — see *Safety and privacy*. |

## Run the helper server on a Raspberry Pi

The server can run anywhere on your network. A Raspberry Pi is a good host: it stays
on, and it does the CPU-heavy encoding instead of your laptop.

A prebuilt image is published for both **arm64** (Pi 3/4/5 on a 64-bit OS) and
**amd64**, so Docker pulls the right one automatically — nothing to build on the Pi.
The image bundles everything the server needs: `yt-dlp`, `ffmpeg`, and a `deno`
JavaScript runtime (plus `yt-dlp-ejs`) that yt-dlp uses to solve YouTube's
challenges.

### Start it

Copy `docker-compose.yml` to the Pi (or clone the repo), then:

```bash
TUNEPULL_TOKEN='pick-a-long-random-string' docker compose up -d
```

That is all. Without a compose file, the same thing with plain Docker:

```bash
docker run -d --name tunepull-server --restart unless-stopped \
  -p 8756:8756 blazanmaric/tunepull-server:latest \
  --token 'pick-a-long-random-string'
```

Update to a newer build later with:

```bash
docker compose pull && docker compose up -d
```

Check it is alive and note the host's address:

```bash
docker logs tunepull-server
docker inspect --format '{{.State.Health.Status}}' tunepull-server   # "healthy"
curl http://<pi-ip>:8756/health        # expect {"version":...} or 401 if a token is set
hostname -I                            # the Pi's LAN IP
```

### Build the image yourself (optional)

You do not need this unless you have changed the server. From the repo root:

```bash
# single-arch, for the machine you are on
docker build -t tunepull-server .

# multi-arch, pushed to your own Docker Hub account
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <your-user>/tunepull-server:latest --push .
```

### Point the extension at the Pi

In the extension's **Options**:

1. **Server URL**: `http://<pi-ip>:8756` (or `http://raspberrypi.local:8756`).
2. **Access token**: the same `TUNEPULL_TOKEN` value.
3. **Trusted hosts**: the Pi's hostname/IP, e.g. `192.168.1.50, raspberrypi.local`.
   Saving the Server URL also adds it automatically.
4. Click **Test connection** — you want a green *Connected*.

Your PC and the Pi must be on the same network, and the PC must be able to reach port
`8756`. Nothing else changes; the extension just sends the track to the Pi instead of
`localhost`.

If downloads fail with **"Sign in to confirm you're not a bot"**, you have two options:

**Let the extension send cookies (recommended for a Pi).** In the extension's Options,
under **YouTube sign-in (cookies)**, tick the automatic sync and click **Send cookies
now**. Chrome on your PC reads its YouTube cookies and sends them to the Pi, which keeps
them in memory. This is the easiest route because the Pi has no browser to read cookies
from. Read the security note in the troubleshooting section first — cookies are account
credentials, so only do this on a Pi you control.

**Or mount a cookies.txt by hand.** Export `cookies.txt` from a browser on your PC (a
"Get cookies.txt" extension, Netscape format), copy it next to `docker-compose.yml`,
then add the volume and the flag:

```yaml
    command: ["--token", "${TUNEPULL_TOKEN:-change-me-please}",
              "--cookies", "/cookies/cookies.txt"]
    volumes:
      - ./cookies.txt:/cookies/cookies.txt:ro
```

Cookies expire, so refresh them (or click **Send cookies now** again) if the wall comes
back.

### Security notes for a network-exposed server

- **Always keep a token set** when the port is reachable beyond your own machine.
- Traffic is plain **HTTP**. Anyone who can reach the host *and* knows the token can
  use it, and can observe the traffic. Keep it on a trusted LAN, or put it behind a
  reverse proxy with TLS (then use `https://...` as the Server URL).
- The extension refuses to send a track to any host you have not listed under
  **Trusted hosts**, so it cannot leak a track to a random address by accident.
- Prefer binding the container to the LAN interface only, and do not port-forward it
  from the internet.

## How it works

| File | Role |
| --- | --- |
| `extension/content.js` | Reads the current track (title, artist, album, video id) from the player bar / player response. |
| `extension/background.js` | Service worker: on an icon click it reads the track, starts a job, polls it, then points `chrome.downloads` at the finished file — into the configured folder. Drives the toolbar badge and notifications. |
| `extension/options.*` | All settings: helper-server URL and token, trusted hosts, quality, download folder, file-name template, notifications, cookie sync. |
| `extension/lib/config.js` | Shared helpers: settings defaults, host trust checks, file-name templates, download-path building. |
| `extension/lib/cookies.js` | Reads YouTube cookies from the browser and formats them as a Netscape `cookies.txt` for the server. |
| `extension/styles.css` | Shared styles for the options page. |
| `server/server.py` | Stdlib-only HTTP server: runs `yt-dlp` + `ffmpeg`, tracks jobs, streams the MP3 or MP4. |
| `tools/make_icons.py` | Regenerates the PNG icons (standard library only). |
| `tools/make_preview.py` | Builds the `preview/` copy of the UI from `extension/`. |
| `tests/*.test.mjs` | `node --test` suites for the pure helpers and the service-worker flow. |

### API used between the two halves

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | `{version, tools, authRequired, jsRuntime, cookies}` — used to show the connection status. |
| `POST` | `/download` | Body `{url\|videoId, title, artist, album, mediaType, quality, videoQuality}` → `{jobId}`. |
| `GET` | `/job/<id>` | `{state, stage, percent, filename, error, cancelled}`. |
| `POST` | `/cancel/<id>` | Stop a queued or running job (kills yt-dlp/ffmpeg). |
| `POST` | `/cookies` | Body `{cookies: "<netscape cookies.txt>"}` (or `{clear: true}`) — signs yt-dlp in. Stored in memory only. |
| `GET` | `/file/<id>` | The finished MP3 or MP4. |

## Safety and privacy

- By default the extension only talks to `localhost` / `127.0.0.1`. To use a server on
  another machine you must list its hostname or IP under **Trusted hosts**; anything
  else is refused, so a track cannot be sent to an unexpected address.
- The server binds to `127.0.0.1` when run directly, and requires a bearer token by
  default. In Docker it binds `0.0.0.0` so the port is reachable — keep the token set
  in that case.
- Because browser downloads cannot send headers, the token is also accepted as a
  `?token=` query parameter on `/file/...`.
- Files are written to a temporary directory and deleted an hour after the job
  finishes (and when the server stops).
- The folder setting is confined to your Downloads directory: `..` and absolute paths
  are stripped, so a template cannot be used to write outside it.
- **YouTube cookies (opt-in).** If you enable cookie sync, the extension reads your
  YouTube session cookies and POSTs them to the helper server so yt-dlp can sign in.
  These are account credentials — anyone holding them can sign in as you. TunePull
  limits the blast radius: only auth cookies (`SID`, `HSID`, `__Secure-*`, …) are sent,
  not the whole jar; they go only to the server you configured; the server writes them
  to a `0600` file in its private temp dir and keeps them in memory, never logging them
  or echoing them back, and forgets everything on restart. The request is still plain
  HTTP unless you put the server behind TLS, so enable this only on a server you
  control. **Forget cookies on server** revokes them immediately.

## Troubleshooting

- **"Cannot reach the helper server"** — is `server/server.py` still running? Is the
  port the same in the options page?
- **401 Unauthorized** — the token in the options page does not match the one printed
  by the server. Re-copy it, or restart with `--no-auth` for local testing.
- **"Helper server is missing: yt-dlp"** — install the missing tool and restart the
  server; check with `yt-dlp --version` and `ffmpeg -version`.
- **Download fails with a yt-dlp error** — the notification shows yt-dlp's own message
  (e.g. `HTTP Error 403: Forbidden`, `This video is unavailable`). YouTube changes
  often; update with `pip install -U yt-dlp` (or rebuild the Docker image).
- **"Sign in to confirm you're not a bot" / `403 Forbidden` on the media stream** —
  YouTube wants proof that a real person is asking, and it is stricter for cloud/VPS or
  datacenter IPs. There are two ways to clear it.

  **Easiest — let the extension send cookies** (best when Chrome and the server are on
  different machines, e.g. Chrome on Windows and the server on a Pi):

  1. Open the extension's **Options** → **YouTube sign-in (cookies)**.
  2. Tick **Send my YouTube cookies to the helper server automatically**.
  3. Click **Send cookies now** to confirm it works (you should see *Sent N …*).

  Cookies are read from your browser and POSTed to the server, which keeps them in
  memory only. They are **account credentials** — see the warning below.

  **Manual — pass a cookies file to the server** (best when the server is on the same
  machine as the browser):

  ```bash
  # Same machine as your browser:
  python server/server.py --cookies-from-browser firefox    # or chrome, edge, brave…

  # Headless box: export cookies.txt in the browser first
  # (a "Get cookies.txt" extension, Netscape format) and pass the file:
  python server/server.py --cookies /path/to/cookies.txt
  ```

  Update yt-dlp too (`pip install -U yt-dlp`) — YouTube changes often, and a fresh
  yt-dlp clears many blocks on its own.

  > **Sending cookies is a real trade-off.** Anyone who has your YouTube cookies can
  > sign in as you. TunePull sends them only to the server you configured, keeps them
  > out of logs and out of the response, and stores them in memory (gone on restart).
  > But if the server is reachable beyond your own machine, that traffic is plain HTTP
  > unless you put it behind TLS — so only enable this on a server you control, and
  > prefer HTTPS. Click **Forget cookies on server** to revoke them at any time.
- **"This video is not available" / "Video unavailable"** — YouTube is refusing that
  specific video, usually because the label restricts it by region or only allows it
  in certain apps. TunePull cannot bypass this, and it is not a server fault: try a
  different upload of the same song.
- **A download stops part-way and Chrome says "Check your internet connection"** — this
  was a bug: a song title containing emoji or non-Latin characters crashed the server
  while it sent the file, so the browser saw the transfer break. Fixed in 1.0.1
  (`Content-Disposition` now uses the RFC 6266 UTF-8 form). Update the image:
  `docker compose pull && docker compose up -d`.
- **"Saved" notification, but no file (or a half-written one)** — fixed in 1.0.1. The
  extension used to announce success as soon as the transfer *started*, so a broken
  download could show both "Saved" and a Chrome error. It now waits for Chrome to
  report the real outcome and reports a failure with the reason instead.
- **A download sits at `95%` for ages and cannot be stopped** — fixed in 1.0.2. `95%`
  is the "Encoding MP3" stage, which for a multi-hour mix can genuinely take minutes.
  Before 1.0.2 there was no way to cancel it. Now **click the toolbar icon again while
  the same song is downloading** to cancel: the server kills yt-dlp/ffmpeg and the
  Chrome download is stopped too.
- **"No supported JavaScript runtime could be found"** — recent yt-dlp versions use a
  JS runtime to fully solve YouTube; without one, formats go missing and some
  downloads fail at random. The published image bundles `deno` and `yt-dlp-ejs`
  (since 1.0.1). If you build your own image, keep those two lines in the `Dockerfile`.
- **`Your kernel does not support memory limit capabilities`** — a harmless Docker
  warning: Raspberry Pi OS disables the memory cgroup controller by default, so the
  `mem_limit` line is discarded. The server still works. Enable it by adding
  `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` (older OS:
  `/boot/cmdline.txt`), rebooting, and uncommenting `mem_limit` in `docker-compose.yml`.

## Development

```bash
# helper server
python server/server.py                 # run (default :8756)
python server/server.py --no-auth       # local testing without a token
python -m py_compile server/server.py   # syntax check

# extension
node --check extension/background.js    # syntax check (any extension JS file)

# tests (pure helpers + service-worker flow)
node --test "tests/*.test.mjs"
python3 tests/test_server.py            # helper server (fake yt-dlp/ffmpeg)

# regenerate icons and the browser preview
python tools/make_icons.py
python tools/make_preview.py
```

### Preview the UI without Chrome

`preview/` renders the real options page against a mocked `chrome.*` API and
recreates the one-click flow (toolbar badge + notification) beside it, so you can
click through the whole thing in a normal browser tab:

```bash
cd preview && python3 -m http.server 8080   # then open http://localhost:8080
```

The preview only fakes the browser APIs; an actual download still needs the helper
server running.

## Legal note

Downloading content you do not own or that is not licensed for download may violate
YouTube's Terms of Service and copyright law. Use this only for content you have the
right to download (your own uploads, public-domain works, or material with a
permissive licence such as Creative Commons). You are responsible for how you use it.

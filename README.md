# TunePull

**One click on the toolbar icon downloads the song you are playing on YouTube Music (or YouTube) as an MP3.**

No popup, no per-song dialog. You configure the destination folder, quality and file
name once in the settings, and after that every download is a single click.

```
┌────────────────────┐   track metadata   ┌──────────────────────┐
│  Chrome extension  │ ─────────────────► │  local helper server │
│  (icon + content)  │ ◄───────────────── │  yt-dlp + ffmpeg     │
└────────────────────┘   progress + MP3   └──────────────────────┘
                                           writes to a temp folder,
                                           streams the .mp3 back
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
- **Quality control.** 128 / 192 / 256 / 320 kbps.
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
TunePull helper server v1.0.0
  listening on http://127.0.0.1:8756
  access token: 5f3c...9a
  -> paste this into the extension's settings page
```

Keep this window open while you download. Useful flags:

| Flag | Meaning |
| --- | --- |
| `--port 8756` | Change the port (keep it in sync with the extension). |
| `--host 127.0.0.1` | Bind address. Leave it on loopback unless you know why. |
| `--token <value>` | Use a fixed token instead of a random one. |
| `--no-auth` | Disable the token entirely (only for a trusted machine). |
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

## Settings

Everything lives on one page (right-click the toolbar icon → *Options*).

| Setting | Default | Notes |
| --- | --- | --- |
| **Server URL** | `http://127.0.0.1:8756` | The helper server. Must match its `--port`. |
| **Access token** | *(empty)* | The token printed by the server. |
| **Trusted hosts** | *(empty)* | Extra hostnames/IPs allowed beyond loopback. |
| **Quality** | 320 kbps | 128 / 192 / 256 / 320. |
| **Save to folder** | `Music/YouTube` | Relative to your Downloads directory. Empty = Downloads itself. |
| **File name** | `{artist} - {title}` | Placeholders: `{title}`, `{artist}`, `{album}`. |
| **Ask me where to save each file** | off | Adds a Save-as dialog (breaks one-click). |
| **Show a notification when a download finishes** | on | Desktop notification with the saved path. |

## Run the helper server on a Raspberry Pi

The server can run anywhere on your network. A Raspberry Pi is a good host: it stays
on, and it does the CPU-heavy encoding instead of your laptop.

A prebuilt image is published for both **arm64** (Pi 3/4/5 on a 64-bit OS) and
**amd64**, so Docker pulls the right one automatically — nothing to build on the Pi.

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
| `extension/options.*` | All settings: helper-server URL and token, trusted hosts, quality, download folder, file-name template, notifications. |
| `extension/lib/config.js` | Shared helpers: settings defaults, host trust checks, file-name templates, download-path building. |
| `extension/styles.css` | Shared styles for the options page. |
| `server/server.py` | Stdlib-only HTTP server: runs `yt-dlp` + `ffmpeg`, tracks jobs, streams the MP3. |
| `tools/make_icons.py` | Regenerates the PNG icons (standard library only). |
| `tools/make_preview.py` | Builds the `preview/` copy of the UI from `extension/`. |
| `tests/*.test.mjs` | `node --test` suites for the pure helpers and the service-worker flow. |

### API used between the two halves

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | `{version, tools, authRequired}` — used to show the connection status. |
| `POST` | `/download` | Body `{url\|videoId, title, artist, album, quality}` → `{jobId}`. |
| `GET` | `/job/<id>` | `{state, stage, percent, filename, error}`. |
| `GET` | `/file/<id>` | The finished MP3. |

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
- **`403 Forbidden` on the media stream** — YouTube is refusing the download from that
  IP. This is common on cloud/VPS or datacenter addresses. Run the server on a normal
  home connection (e.g. the Pi on your LAN).
- **"No supported JavaScript runtime could be found"** — recent yt-dlp versions use a
  JS runtime to fully solve YouTube. Add `deno` to the image (see the commented lines
  in the `Dockerfile`) if you see missing-format warnings.

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

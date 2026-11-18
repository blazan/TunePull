# UI preview (no Chrome needed)

Renders the **real** options page against a mocked `chrome.*` API and recreates the
one-click download flow beside it, so you can see and click through everything
without loading the extension.

```bash
cd preview
python3 -m http.server 8080
# open http://localhost:8080
```

The left panel simulates the toolbar icon: click the ♪ icon (or a scenario button)
to watch the badge go from a percentage to a ✓ and the finish notification appear.
The right panel is `extension/options.html` in an iframe, with `preview/mock.js`
injected ahead of the real script, so the actual settings UI and its live file-name
preview are what you are editing.

There is no popup any more — a click on the toolbar icon runs the whole
flow in the extension's service worker, which a plain web page cannot host, so the
badge and notification are recreated by hand in `index.html`.

This only fakes `chrome.storage`, `chrome.runtime.sendMessage`, and the downloads
API. A real download still needs a running helper server with `yt-dlp` and
`ffmpeg`. Run `python tools/make_preview.py` to regenerate the preview files from
the extension sources.

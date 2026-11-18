/**
 * Content script: reads what is currently playing and hands the metadata to the
 * service worker. It never touches the network itself.
 */

(() => {
  const clean = (value) => (typeof value === "string" ? value.trim() : "");

  /** Pull the `v=` query parameter from any of the YouTube URL shapes. */
  function videoIdFromUrl(href) {
    try {
      const url = new URL(href, location.origin);
      const direct = url.searchParams.get("v");
      if (direct) return direct;
      // youtube.com/shorts/<id> and youtu.be/<id>
      const pathMatch = url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (pathMatch) return pathMatch[1];
      if (url.hostname.endsWith("youtu.be")) {
        const id = url.pathname.slice(1).split("/")[0];
        if (id) return id;
      }
    } catch {
      /* ignore malformed URLs */
    }
    return "";
  }

  function textOf(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = clean(el?.textContent);
      if (text) return text;
    }
    return "";
  }

  function attrOf(selectors, attr) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = clean(el?.getAttribute(attr));
      if (value) return value;
    }
    return "";
  }

  /** "Artist • Album • 2023" -> { artist, album } */
  function parseByline(raw) {
    const parts = clean(raw)
      .split(/\s*[•·|]\s*/)
      .map(clean)
      .filter(Boolean);
    return { artist: parts[0] || "", album: parts[1] || "" };
  }

  /** YouTube Music puts the artist in the player bar; fall back to the page title. */
  function ytMusicTrack() {
    const title = textOf([
      "ytmusic-player-bar .title",
      "ytmusic-player-bar yt-formatted-string.title",
      "ytmusic-app-layout ytmusic-player-bar [slot='title']",
    ]);
    const byline = textOf(["ytmusic-player-bar .byline", "ytmusic-player-bar .subtitle"]);
    const { artist, album } = parseByline(byline);

    const thumbnail = attrOf(
      [
        "ytmusic-player-bar img.thumbnail",
        "ytmusic-player-bar .thumbnail img",
        "ytmusic-player-bar img",
      ],
      "src",
    );

    const duration = textOf([
      "ytmusic-player-bar .time-info",
      "ytmusic-player-bar yt-formatted-string.time-info",
    ]);

    const videoId =
      clean(document.querySelector("ytmusic-player-bar")?.getAttribute("video-id")) ||
      videoIdFromUrl(location.href);

    return { title, artist, album, thumbnail, duration, videoId };
  }

  /** Plain YouTube: the player response object has the cleanest data. */
  function youTubeTrack() {
    const response = window.ytInitialPlayerResponse;
    const details = response?.videoDetails || {};
    const title = clean(details.title) || clean(document.title.replace(/\s*-\s*YouTube\s*$/, ""));
    const artist = clean(details.author);
    const videoId = clean(details.videoId) || videoIdFromUrl(location.href);

    let thumbnail = "";
    const thumbs = details.thumbnail?.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length) {
      thumbnail = clean(thumbs[thumbs.length - 1]?.url);
    }
    if (!thumbnail) {
      thumbnail = attrOf(['meta[property="og:image"]'], "content");
    }

    const seconds = Number(details.lengthSeconds);
    const duration = Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds) : "";

    return { title, artist, album: "", thumbnail, duration, videoId };
  }

  function formatDuration(totalSeconds) {
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function readTrack() {
    const isMusic = location.hostname === "music.youtube.com";
    const track = isMusic ? ytMusicTrack() : youTubeTrack();

    if (!track.title) track.title = clean(document.title);
    if (!track.videoId) track.videoId = videoIdFromUrl(location.href);

    return {
      ...track,
      pageUrl: location.href,
      isMusic,
      source: isMusic ? "YouTube Music" : "YouTube",
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "tunepull:getTrack") {
      try {
        sendResponse({ ok: true, track: readTrack() });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return true;
    }
    return false;
  });
})();

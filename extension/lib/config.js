/** Shared settings for the extension and the local helper server contract. */

export const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8756",
  serverToken: "",
  trustedHosts: [], // extra hostnames (besides loopback) the server may live on
  mediaType: "audio", // "audio" (MP3) or "video" (MP4) — what a click downloads
  quality: "320", // audio kbps: 128 | 192 | 256 | 320
  downloadFolder: "", // path inside the browser's Downloads directory, e.g. "Music/YT"
  filenameTemplate: "{artist} - {title}",
  videoQuality: "best", // best | 2160 | 1440 | 1080 | 720 | 480 | 360
  videoFolder: "", // videos get their own folder setting
  videoFilenameTemplate: "{artist} - {title}",
  askWhereToSave: false, // when true the browser shows a Save-as dialog
  notifyOnFinish: true,
  // Off by default: this uploads YouTube session cookies (account credentials) to
  // the helper server, so it is an explicit opt-in.
  syncCookies: false,
};

export const AUDIO_EXT = ".mp3";
export const VIDEO_EXT = ".mp4";

/** Loopback is always allowed, no matter what the user configures. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ""); // strip IPv6 brackets
}

/** True when `hostname` is loopback or explicitly listed in `trustedHosts`. */
export function isTrustedHost(hostname, trustedHosts) {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTS.has(host)) return true;
  return (trustedHosts || []).some((entry) => normalizeHost(entry) === host);
}

/** Turn text typed into an input/textarea into a clean array of hostnames. */
export function parseHostList(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter(Boolean);
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

/** Strip characters that are illegal or awkward in file names. */
export function sanitizeFileName(name, fallback = "audio") {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 150);
  return cleaned || fallback;
}

export const DEFAULT_FILENAME_TEMPLATE = "{artist} - {title}";

export function buildFileName(track, template = DEFAULT_FILENAME_TEMPLATE) {
  const values = {
    title: sanitizeFileName(track?.title, "Unknown title"),
    artist: sanitizeFileName(track?.artist, ""),
    album: sanitizeFileName(track?.album, ""),
  };

  let tpl = String(template || "").trim() || DEFAULT_FILENAME_TEMPLATE;
  // Drop bracketed optional fields entirely when they are empty, e.g. with no
  // artist "{title} ({artist})" becomes "{title}" rather than "Title ()".
  for (const key of ["artist", "album"]) {
    if (!values[key]) {
      tpl = tpl.replace(new RegExp(`\\(\\s*\\{${key}\\}\\s*\\)|\\[\\s*\\{${key}\\}\\s*\\]`, "g"), "");
    }
  }

  const rendered = tpl
    .replace(/\{(title|artist|album)\}/g, (_, key) => values[key])
    .replace(/\(\s*\)|\[\s*\]/g, "") // any brackets left empty
    // Collapse separators orphaned by an empty field, e.g. " - Title".
    .replace(/\s*-\s*-\s*/g, " - ")
    .replace(/^[\s-]+/, "")
    .replace(/[\s-]+$/, "");
  return sanitizeFileName(rendered, values.title || "audio");
}

/**
 * Join the user's download folder with a file name.
 * `chrome.downloads` treats the path as relative to the Downloads directory and
 * rejects absolute paths or any "..", so both are stripped here.
 */
export function buildDownloadPath(folder, filename, ext = AUDIO_EXT) {
  const suffix = ext === VIDEO_EXT ? VIDEO_EXT : AUDIO_EXT;
  const stem = sanitizeFileName(filename, "audio").replace(/\.(mp3|mp4)$/i, "");
  const safeFile = stem + suffix;
  const segments = String(folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => sanitizeFileName(part, ""))
    .filter(Boolean);
  return [...segments, safeFile].join("/");
}

/** True when a click should produce a video rather than an MP3. */
export function isVideoMode(settings) {
  return String(settings?.mediaType || "audio").toLowerCase() === "video";
}

/**
 * Resolve the folder/template/extension for the configured media type.
 * Audio and video keep separate settings, so switching mode never loses the
 * other's choices.
 */
export function mediaSettings(settings) {
  const video = isVideoMode(settings);
  return {
    video,
    mediaType: video ? "video" : "audio",
    ext: video ? VIDEO_EXT : AUDIO_EXT,
    folder: video ? settings?.videoFolder || "" : settings?.downloadFolder || "",
    template:
      (video ? settings?.videoFilenameTemplate : settings?.filenameTemplate) ||
      DEFAULT_FILENAME_TEMPLATE,
  };
}

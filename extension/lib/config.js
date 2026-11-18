/** Shared settings for the extension and the local helper server contract. */

export const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8756",
  serverToken: "",
  trustedHosts: [], // extra hostnames (besides loopback) the server may live on
  quality: "320", // kbps: 128 | 192 | 256 | 320
  downloadFolder: "", // path inside the browser's Downloads directory, e.g. "Music/YT"
  filenameTemplate: "{artist} - {title}",
  askWhereToSave: false, // when true the browser shows a Save-as dialog
  notifyOnFinish: true,
};

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
export function buildDownloadPath(folder, filename) {
  const safeFile = sanitizeFileName(filename, "audio").replace(/\.mp3$/i, "") + ".mp3";
  const segments = String(folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => sanitizeFileName(part, ""))
    .filter(Boolean);
  return [...segments, safeFile].join("/");
}

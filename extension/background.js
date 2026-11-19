/**
 * Service worker.
 *
 * There is no popup: clicking the toolbar icon (or pressing the shortcut) starts
 * the whole download immediately. We read the current track from the page, POST
 * it to the helper server, poll until the MP3 is ready, then hand the finished
 * file to the downloads API — into the folder chosen in the settings.
 *
 * Progress is shown on the toolbar badge, and the outcome as a notification.
 */

import {
  getSettings,
  saveSettings,
  buildFileName,
  buildDownloadPath,
  isTrustedHost,
  mediaSettings,
  actionTitle,
  isVideoMode,
} from "./lib/config.js";
import { collectCookieFile } from "./lib/cookies.js";

const POLL_INTERVAL_MS = 700;

/** jobId -> { track, percent } for jobs still being converted. */
const activeJobs = new Map();
/** Keys (video id / url / title) of downloads currently in flight, to dedupe clicks. */
const inFlight = new Set();
/** key -> { jobId, downloadId, cancelled } for the in-flight download, so a
 * second click can stop it during either the conversion or the file transfer. */
const inFlightJobs = new Map();

/** Thrown when the user cancels; not an error, so it gets no failure notification. */
class CancelledError extends Error {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Only loopback and hosts the user explicitly trusted are accepted. */
function parseServer(urlString, trustedHosts) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid server URL: ${urlString}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  if (!isTrustedHost(url.hostname, trustedHosts)) {
    throw new Error(
      `Refusing to send the request to "${url.hostname}". Add it under ` +
        `"Trusted hosts" in the extension settings first.`,
    );
  }
  return url;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(response) {
  try {
    const data = await response.json();
    return data?.error || `Server responded with ${response.status}`;
  } catch {
    return `Server responded with ${response.status} ${response.statusText}`.trim();
  }
}

/** Absolute URL of the most recently focused normal tab. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** Ask the content script for the current track, injecting it if needed. */
async function requestTrackFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "tunepull:getTrack" });
    if (response?.ok) return response.track;
  } catch {
    // No content script yet (tab predates install) — inject and retry once.
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const response = await chrome.tabs.sendMessage(tabId, { type: "tunepull:getTrack" });
  if (!response?.ok) throw new Error(response?.error || "Could not read the current track");
  return response.track;
}

async function fetchTrackFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found");

  const supported = /^https:\/\/(music|www)\.youtube\.com\//.test(tab.url || "");
  if (!supported) throw new Error("Open a YouTube Music or YouTube tab first");
  return requestTrackFromTab(tab.id);
}

// ---------------------------------------------------------------------------
// Badge + notifications
// ---------------------------------------------------------------------------

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color: color || "#ff0033" });
  await chrome.action.setBadgeText({ text: text || "" });
}

/** Reflect overall progress on the toolbar icon. */
function refreshBadge() {
  const jobs = [...activeJobs.values()];
  if (jobs.length === 0) return; // keep any transient done/error badge
  if (jobs.length > 1) return setBadge(`+${jobs.length}`, "#ff0033");
  const percent = jobs[0].percent;
  return setBadge(percent == null ? "…" : `${Math.floor(percent)}%`, "#ff0033");
}

async function notify(title, message) {
  try {
    const { notifyOnFinish } = await getSettings();
    if (!notifyOnFinish) return;
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: message || "",
      silent: true,
    });
  } catch {
    // Notifications are best-effort; the badge still shows the result.
  }
}

/** Briefly show an outcome on the badge, then clear it. */
function flashBadge(text, color) {
  setBadge(text, color);
  setTimeout(() => {
    if (activeJobs.size === 0) setBadge("");
  }, 4000);
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

/** Kick off conversion on the helper server; resolves to a job id. */
async function startJob(track) {
  const settings = await getSettings();
  const media = mediaSettings(settings);
  const endpoint = new URL("/download", parseServer(settings.serverUrl, settings.trustedHosts));

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(settings.serverToken) },
      body: JSON.stringify({
        url: track.pageUrl,
        videoId: track.videoId || "",
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
        mediaType: media.mediaType,
        // Audio wants a bitrate; video wants a height cap ("best" = no cap).
        quality: String(settings.quality || "320"),
        videoQuality: String(settings.videoQuality || "best"),
      }),
    });
  } catch {
    throw new Error(
      `Cannot reach the helper server at ${settings.serverUrl}. Is it running? (see README)`,
    );
  }

  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  if (!data?.jobId) throw new Error("Helper server did not return a job id");
  return data.jobId;
}

/** Poll one job; resolves to its current status object. */
async function pollJob(jobId) {
  const settings = await getSettings();
  const endpoint = new URL(
    `/job/${encodeURIComponent(jobId)}`,
    parseServer(settings.serverUrl, settings.trustedHosts),
  );

  const response = await fetch(endpoint, { headers: authHeaders(settings.serverToken) });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/** Ask the helper server to stop a running job (best effort). */
async function cancelJob(jobId) {
  const settings = await getSettings();
  const endpoint = new URL(
    `/cancel/${encodeURIComponent(jobId)}`,
    parseServer(settings.serverUrl, settings.trustedHosts),
  );
  try {
    await fetch(endpoint, { method: "POST", headers: authHeaders(settings.serverToken) });
  } catch {
    // The server may already be gone; the local flow is cancelled either way.
  }
}

/** Stop the in-flight download for `key`, whether it is converting or transferring. */
async function cancelDownload(key) {
  const record = inFlightJobs.get(key);
  if (!record) return;
  record.cancelled = true;
  if (record.downloadId != null) {
    // The file is already being written: stop Chrome too.
    try {
      await chrome.downloads.cancel(record.downloadId);
    } catch {
      // Already finished or gone; nothing to stop.
    }
  } else if (record.jobId) {
    await cancelJob(record.jobId);
  }
}

/**
 * Upload this browser's YouTube cookies to the helper server.
 *
 * Only ever called for a server the user trusts, and only when they opted in.
 * Returns the server's response ({ok, cookies, count}); throws on failure so the
 * caller can surface it.
 */
async function syncCookiesToServer() {
  const settings = await getSettings();
  const endpoint = new URL("/cookies", parseServer(settings.serverUrl, settings.trustedHosts));
  const { text, count } = await collectCookieFile();
  if (!count) {
    throw new Error("No YouTube cookies found — sign in to YouTube in this browser first");
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(settings.serverToken) },
      body: JSON.stringify({ cookies: text }),
    });
  } catch {
    throw new Error(`Cannot reach the helper server at ${settings.serverUrl}`);
  }
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/** Best-effort sync before a download; a failure must not block the download. */
async function maybeSyncCookies() {
  try {
    const { syncCookies } = await getSettings();
    if (!syncCookies) return;
    await syncCookiesToServer();
  } catch {
    // The download will still run; if the bot wall bites, the server error hints
    // at cookies, and the options page can report the sync problem.
  }
}

/** Build the file URL (token goes in the query string: downloads carry no headers). */
async function fileUrlFor(jobId) {
  const settings = await getSettings();
  const url = new URL(
    `/file/${encodeURIComponent(jobId)}`,
    parseServer(settings.serverUrl, settings.trustedHosts),
  );
  if (settings.serverToken) url.searchParams.set("token", settings.serverToken);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Download orchestration
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve once Chrome reports the download's terminal state.
 *
 * chrome.downloads.download() resolves when the transfer *starts*, so awaiting it
 * alone would announce "Saved" before the bytes are on disk — and a transfer that
 * then fails would show both a success and an error. Waiting on onChanged also
 * lets the event wake a suspended service worker. The timeout is a safety net so
 * a missed event cannot leave the promise pending forever.
 */
function waitForDownload(downloadId, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const finish = (outcome) => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(outcome);
    };
    const listener = (delta) => {
      if (delta?.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === "complete") finish({ ok: true });
      else if (state === "interrupted") finish({ ok: false, error: delta.error?.current || "" });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "TIMEOUT" }), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
  });
}

/** Chrome's download-interrupt reasons, in words the user can act on. */
function downloadErrorMessage(reason, filename) {
  switch (reason) {
    case "NETWORK_FAILED":
      return `The connection dropped while saving ${filename}. If the helper server was restarted, try again.`;
    case "FILE_FAILED":
    case "FILE_ACCESS_DENIED":
    case "FILE_NO_SPACE":
      return `Chrome could not write ${filename} (${reason}). Check the download folder and free space.`;
    case "SERVER_BAD_CONTENT":
    case "SERVER_FAILED":
      return `The helper server stopped sending ${filename} before it finished.`;
    case "TIMEOUT":
      return `Timed out waiting for ${filename} to finish saving.`;
    default:
      return reason
        ? `The download of ${filename} failed (${reason}).`
        : `The download of ${filename} failed.`;
  }
}

/** POST, poll, then save — the full flow for one click. */
async function runDownload(track, key) {
  let jobId = null;

  try {
    // Inside the try: failing to even start the job (server down, host not
    // trusted) is the most common error and must reach the user too.
    await maybeSyncCookies();
    jobId = await startJob(track);
    activeJobs.set(jobId, { track, percent: null });
    // Published before the first poll, so a second click can cancel immediately.
    if (key) inFlightJobs.set(key, { jobId, downloadId: null, cancelled: false });
    refreshBadge();

    for (;;) {
      await delay(POLL_INTERVAL_MS);
      const status = await pollJob(jobId);

      // Updating the badge each tick also keeps the service worker alive for the
      // whole (possibly minutes-long) conversion.
      const job = activeJobs.get(jobId);
      if (job) job.percent = status.percent ?? null;
      refreshBadge();

      if (inFlightJobs.get(key)?.cancelled) throw new CancelledError("Cancelled");
      if (status.state === "done") break;
      if (status.state === "error") throw new Error(status.error || "Conversion failed");
      if (status.state === "cancelled") throw new CancelledError("Cancelled");
    }

    const settings = await getSettings();
    const media = mediaSettings(settings);
    const filename = buildDownloadPath(
      media.folder,
      buildFileName(track, media.template),
      media.ext,
    );

    const downloadId = await chrome.downloads.download({
      url: await fileUrlFor(jobId),
      filename,
      saveAs: Boolean(settings.askWhereToSave),
      conflictAction: "uniquify",
    });

    // From here the file is streaming, so a cancel must stop Chrome, not the server.
    const record = key ? inFlightJobs.get(key) : null;
    if (record) record.downloadId = downloadId;
    if (record?.cancelled) {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      throw new CancelledError("Cancelled");
    }

    // download() resolves when the transfer starts, not when it finishes.
    const outcome = await waitForDownload(downloadId);
    // A cancel during the transfer may still land as "complete"; trust the flag.
    if (record?.cancelled) throw new CancelledError("Cancelled");
    if (!outcome.ok) {
      // Cancelling the Save-as dialog is a choice, not an error.
      if (outcome.error === "USER_CANCELED") {
        setBadge("");
        return;
      }
      throw new Error(downloadErrorMessage(outcome.error, filename));
    }

    flashBadge("✓", "#34d399");
    await notify("Saved", filename);
  } catch (error) {
    if (error instanceof CancelledError) {
      // A deliberate stop: clear the badge, say nothing.
      flashBadge("", "#ff0033");
      return;
    }
    flashBadge("!", "#f87171");
    await notify("Download failed", error?.message || String(error));
    throw error;
  } finally {
    if (jobId) activeJobs.delete(jobId);
  }
}

/** Entry point for a click on the toolbar icon or the keyboard shortcut. */
async function handleAction() {
  let track;
  try {
    track = await fetchTrackFromActiveTab();
  } catch (error) {
    flashBadge("!", "#f87171");
    await notify("TunePull", error?.message || String(error));
    return;
  }
  if (!track?.title) {
    flashBadge("!", "#f87171");
    await notify("TunePull", "Could not read the current track");
    return;
  }

  // Added synchronously, so a second click in the same tick cannot also start.
  const key = track.videoId || track.pageUrl || track.title;

  // Clicking the same track again while it is running cancels it: this is the only
  // way to stop a long conversion, since there is no popup to hold a button.
  if (inFlightJobs.has(key)) {
    await cancelDownload(key);
    return;
  }
  if (inFlight.has(key)) return;

  inFlight.add(key);

  try {
    await runDownload(track, key); // errors are already surfaced by runDownload
  } catch {
    // ignore: the notification has been shown
  } finally {
    inFlight.delete(key);
    inFlightJobs.delete(key);
  }
}

chrome.action.onClicked.addListener(handleAction);

/**
 * Keep the toolbar tooltip honest: the manifest's static title says "MP3", so a
 * user who switched to video mode was told the wrong thing. The service worker
 * is the only place that can read the setting, so it sets the title itself.
 */
async function refreshActionTitle() {
  try {
    await chrome.action.setTitle({ title: actionTitle(await getSettings()) });
  } catch {
    // A missing action API (or a transient storage error) must not break downloads.
  }
}

refreshActionTitle();

chrome.runtime.onInstalled.addListener(refreshActionTitle);
chrome.runtime.onStartup.addListener(refreshActionTitle);

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "download-current-track") handleAction();
  });
}

// ---------------------------------------------------------------------------
// Right-click menu: switch format without opening the options page
// ---------------------------------------------------------------------------

const MENU_AUDIO = "tunepull-format-audio";
const MENU_VIDEO = "tunepull-format-video";
const MENU_OPTIONS = "tunepull-options";

/**
 * The radio marks the active format, so the menu doubles as a status indicator.
 * Chrome persists menu items per extension id, so remove first to avoid
 * "duplicate id" errors on update/restart.
 *
 * Only the newest rebuild may create items: a wake-up rebuild and a
 * storage.onChanged rebuild can overlap, and their removeAll callbacks may fire
 * interleaved, which would otherwise create each id twice.
 */
let menuBuild = 0;

function buildFormatMenu(video) {
  if (!chrome.contextMenus?.create) return;
  const build = ++menuBuild;
  chrome.contextMenus.removeAll(() => {
    if (build !== menuBuild) return; // superseded by a newer rebuild
    void chrome.runtime.lastError; // nothing to remove on a first run
    chrome.contextMenus.create({
      id: MENU_AUDIO,
      title: "Download as MP3",
      type: "radio",
      checked: !video,
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: MENU_VIDEO,
      title: "Download as MP4 video",
      type: "radio",
      checked: video,
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: MENU_OPTIONS,
      title: "All settings…",
      contexts: ["action"],
    });
  });
}

async function refreshFormatMenu() {
  buildFormatMenu(isVideoMode(await getSettings()));
}

if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => refreshFormatMenu());
  chrome.runtime.onStartup.addListener(() => refreshFormatMenu());

  // The service worker is torn down while idle; the menu survives but its radio
  // state can go stale, so re-sync it whenever the worker wakes.
  refreshFormatMenu();

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_OPTIONS) {
      chrome.runtime.openOptionsPage();
      return;
    }
    if (info.menuItemId !== MENU_AUDIO && info.menuItemId !== MENU_VIDEO) return;
    // saveSettings fires storage.onChanged, which redraws the menu and the title.
    saveSettings({ mediaType: info.menuItemId === MENU_VIDEO ? "video" : "audio" })
      .catch(() => {}); // a failed write leaves the old mode; nothing to report
  });
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.mediaType) return;
    refreshActionTitle();
    refreshFormatMenu();
  });
}

/** Message router — used by the options page to test the connection. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "tunepull:ping": {
          const settings = await getSettings();
          let endpoint;
          try {
            endpoint = new URL("/health", parseServer(settings.serverUrl, settings.trustedHosts));
          } catch (error) {
            sendResponse({ ok: false, error: error.message });
            return;
          }
          try {
            const response = await fetch(endpoint, {
              headers: authHeaders(settings.serverToken),
            });
            if (!response.ok) {
              sendResponse({ ok: false, error: await readError(response) });
              return;
            }
            sendResponse({ ok: true, data: await response.json() });
          } catch {
            sendResponse({ ok: false, error: `No response from ${settings.serverUrl}` });
          }
          break;
        }
        case "tunepull:getTrack":
          sendResponse({ ok: true, track: await fetchTrackFromActiveTab() });
          break;
        case "tunepull:syncCookies": {
          try {
            const data = await syncCookiesToServer();
            sendResponse({ ok: true, data });
          } catch (error) {
            sendResponse({ ok: false, error: error?.message || String(error) });
          }
          break;
        }
        case "tunepull:clearCookies": {
          const settings = await getSettings();
          let endpoint;
          try {
            endpoint = new URL(
              "/cookies",
              parseServer(settings.serverUrl, settings.trustedHosts),
            );
          } catch (error) {
            sendResponse({ ok: false, error: error.message });
            return;
          }
          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders(settings.serverToken) },
              body: JSON.stringify({ clear: true }),
            });
            if (!response.ok) {
              sendResponse({ ok: false, error: await readError(response) });
              return;
            }
            sendResponse({ ok: true, data: await response.json() });
          } catch {
            sendResponse({ ok: false, error: `No response from ${settings.serverUrl}` });
          }
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true; // keep the channel open for the async response
});

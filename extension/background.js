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
  buildFileName,
  buildDownloadPath,
  isTrustedHost,
} from "./lib/config.js";

const POLL_INTERVAL_MS = 700;

/** jobId -> { track, percent } for jobs still being converted. */
const activeJobs = new Map();
/** Keys (video id / url / title) of downloads currently in flight, to dedupe clicks. */
const inFlight = new Set();
/** downloadId -> { filename, jobId } for files handed to the downloads API. */
const pendingDownloads = new Map();

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
        quality: String(settings.quality || "320"),
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

/** POST, poll, then save — the full flow for one click. */
async function runDownload(track) {
  let jobId = null;

  try {
    // Inside the try: failing to even start the job (server down, host not
    // trusted) is the most common error and must reach the user too.
    jobId = await startJob(track);
    activeJobs.set(jobId, { track, percent: null });
    refreshBadge();

    for (;;) {
      await delay(POLL_INTERVAL_MS);
      const status = await pollJob(jobId);

      // Updating the badge each tick also keeps the service worker alive for the
      // whole (possibly minutes-long) conversion.
      const job = activeJobs.get(jobId);
      if (job) job.percent = status.percent ?? null;
      refreshBadge();

      if (status.state === "done") break;
      if (status.state === "error") throw new Error(status.error || "Conversion failed");
    }

    const settings = await getSettings();
    const filename = buildDownloadPath(
      settings.downloadFolder,
      buildFileName(track, settings.filenameTemplate),
    );

    const downloadId = await chrome.downloads.download({
      url: await fileUrlFor(jobId),
      filename,
      saveAs: Boolean(settings.askWhereToSave),
      conflictAction: "uniquify",
    });

    pendingDownloads.set(downloadId, { filename, jobId });
    flashBadge("✓", "#34d399");
    await notify("Saved", filename);
  } catch (error) {
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
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    await runDownload(track); // errors are already surfaced by runDownload
  } catch {
    // ignore: the notification has been shown
  } finally {
    inFlight.delete(key);
  }
}

// A finished download clears its own bookkeeping.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta?.state?.current === "complete") pendingDownloads.delete(delta.id);
});

chrome.action.onClicked.addListener(handleAction);

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "download-current-track") handleAction();
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
        default:
          sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true; // keep the channel open for the async response
});

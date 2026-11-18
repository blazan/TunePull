import {
  DEFAULTS,
  getSettings,
  saveSettings,
  parseHostList,
  isTrustedHost,
  buildFileName,
  buildDownloadPath,
} from "./lib/config.js";

const el = (id) => document.getElementById(id);
const ui = {
  serverUrl: el("server-url"),
  serverToken: el("server-token"),
  trustedHosts: el("trusted-hosts"),
  mediaType: el("media-type"),
  quality: el("quality"),
  folder: el("download-folder"),
  template: el("filename-template"),
  namePreview: el("name-preview"),
  videoQuality: el("video-quality"),
  videoFolder: el("video-folder"),
  videoTemplate: el("video-filename-template"),
  videoNamePreview: el("video-name-preview"),
  audioSettings: el("audio-settings"),
  videoSettings: el("video-settings"),
  askSave: el("ask-save"),
  notify: el("notify"),
  syncCookies: el("sync-cookies"),
  syncCookiesNow: el("sync-cookies-now"),
  clearCookies: el("clear-cookies"),
  status: el("status"),
};

const SAMPLE_TRACK = { title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera" };

function showStatus(text, kind = "") {
  ui.status.hidden = !text;
  ui.status.textContent = text || "";
  ui.status.className = `status ${kind}`.trim();
}

/** Render a sample path for one media type, so the preview matches what will be saved. */
function renderPreview(track, folder, template, ext, target) {
  const name = buildFileName(track, template || DEFAULTS.filenameTemplate);
  target.textContent = buildDownloadPath(folder.trim(), name, ext);
}

function updatePreview() {
  renderPreview(SAMPLE_TRACK, ui.folder.value, ui.template.value, ".mp3", ui.namePreview);
  renderPreview(
    SAMPLE_TRACK,
    ui.videoFolder.value,
    ui.videoTemplate.value,
    ".mp4",
    ui.videoNamePreview,
  );
}

/** Dim the group that the current "Download as" choice will not use. */
function updateMediaMode() {
  const video = ui.mediaType.value === "video";
  ui.audioSettings.classList.toggle("inactive", video);
  ui.videoSettings.classList.toggle("inactive", !video);
}

async function load() {
  const settings = await getSettings();
  ui.serverUrl.value = settings.serverUrl;
  ui.serverToken.value = settings.serverToken;
  ui.trustedHosts.value = (settings.trustedHosts || []).join(", ");
  ui.mediaType.value = settings.mediaType === "video" ? "video" : "audio";
  ui.quality.value = String(settings.quality);
  ui.folder.value = settings.downloadFolder || "";
  ui.template.value = settings.filenameTemplate || DEFAULTS.filenameTemplate;
  ui.videoQuality.value = String(settings.videoQuality || "best");
  ui.videoFolder.value = settings.videoFolder || "";
  ui.videoTemplate.value = settings.videoFilenameTemplate || DEFAULTS.videoFilenameTemplate;
  ui.askSave.checked = Boolean(settings.askWhereToSave);
  ui.notify.checked = Boolean(settings.notifyOnFinish);
  ui.syncCookies.checked = Boolean(settings.syncCookies);
  updateMediaMode();
  updatePreview();
}

/** Collect the form into a settings patch, adding the server host if needed. */
function collect() {
  const serverUrl = ui.serverUrl.value.trim();
  const trustedHosts = parseHostList(ui.trustedHosts.value);

  // Catch a mismatch before it turns into a confusing failure later.
  try {
    const host = new URL(serverUrl).hostname;
    if (!isTrustedHost(host, trustedHosts)) {
      trustedHosts.push(host);
      ui.trustedHosts.value = trustedHosts.join(", ");
    }
  } catch {
    showStatus("That server URL is not valid.", "err");
    return null;
  }

  return {
    serverUrl,
    serverToken: ui.serverToken.value.trim(),
    trustedHosts,
    mediaType: ui.mediaType.value === "video" ? "video" : "audio",
    quality: ui.quality.value,
    downloadFolder: ui.folder.value.trim(),
    filenameTemplate: ui.template.value.trim() || DEFAULTS.filenameTemplate,
    videoQuality: ui.videoQuality.value,
    videoFolder: ui.videoFolder.value.trim(),
    videoFilenameTemplate: ui.videoTemplate.value.trim() || DEFAULTS.videoFilenameTemplate,
    askWhereToSave: ui.askSave.checked,
    notifyOnFinish: ui.notify.checked,
    syncCookies: ui.syncCookies.checked,
  };
}

async function save() {
  const patch = collect();
  if (!patch) return false;
  await saveSettings(patch);
  showStatus("Saved.", "ok");
  return true;
}

async function test() {
  if (!(await save())) return;
  showStatus("Contacting server…");
  const res = await chrome.runtime.sendMessage({ type: "tunepull:ping" });
  if (res?.ok) {
    const version = res.data?.version ? ` (v${res.data.version})` : "";
    const tools = res.data?.tools ? ` — ${res.data.tools.join(", ")}` : "";
    const cookies = res.data && res.data.cookies === false ? " — no cookies (YouTube may ask for sign-in)" : "";
    showStatus(`Connected${version}${tools}${cookies}`, "ok");
  } else {
    showStatus(res?.error || "Could not reach the server", "err");
  }
}

async function syncCookiesNow() {
  if (!(await save())) return;
  showStatus("Sending cookies…");
  const res = await chrome.runtime.sendMessage({ type: "tunepull:syncCookies" });
  if (res?.ok) {
    const count = res.data?.count;
    showStatus(`Sent ${count ?? "the"} YouTube cookie${count === 1 ? "" : "s"} to the server.`, "ok");
  } else {
    showStatus(res?.error || "Could not send cookies", "err");
  }
}

async function clearServerCookies() {
  if (!(await save())) return;
  showStatus("Clearing cookies…");
  const res = await chrome.runtime.sendMessage({ type: "tunepull:clearCookies" });
  if (res?.ok) {
    showStatus("The server has forgotten the cookies.", "ok");
  } else {
    showStatus(res?.error || "Could not clear cookies", "err");
  }
}

// Save on change so a forgotten "Save" click can never lose a setting.
for (const field of [
  ui.serverUrl,
  ui.serverToken,
  ui.trustedHosts,
  ui.mediaType,
  ui.quality,
  ui.folder,
  ui.template,
  ui.videoQuality,
  ui.videoFolder,
  ui.videoTemplate,
]) {
  field.addEventListener("change", save);
}
for (const input of [ui.template, ui.folder, ui.videoTemplate, ui.videoFolder]) {
  input.addEventListener("input", updatePreview);
}
ui.mediaType.addEventListener("change", updateMediaMode);
for (const box of [ui.askSave, ui.notify, ui.syncCookies]) {
  box.addEventListener("change", save);
}
el("test").addEventListener("click", test);
el("save").addEventListener("click", save);
ui.syncCookiesNow.addEventListener("click", syncCookiesNow);
ui.clearCookies.addEventListener("click", clearServerCookies);

load();

import {
  DEFAULTS,
  getSettings,
  saveSettings,
  parseHostList,
  isTrustedHost,
  buildFileName,
} from "./lib/config.js";

const el = (id) => document.getElementById(id);
const ui = {
  serverUrl: el("server-url"),
  serverToken: el("server-token"),
  trustedHosts: el("trusted-hosts"),
  quality: el("quality"),
  folder: el("download-folder"),
  template: el("filename-template"),
  namePreview: el("name-preview"),
  askSave: el("ask-save"),
  notify: el("notify"),
  status: el("status"),
};

const SAMPLE_TRACK = { title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera" };

function showStatus(text, kind = "") {
  ui.status.hidden = !text;
  ui.status.textContent = text || "";
  ui.status.className = `status ${kind}`.trim();
}

function updatePreview() {
  const name = buildFileName(SAMPLE_TRACK, ui.template.value || DEFAULTS.filenameTemplate);
  const folder = ui.folder.value.trim().replace(/^\/+|\/+$/g, "");
  ui.namePreview.textContent = `${folder ? folder + "/" : ""}${name}.mp3`;
}

async function load() {
  const settings = await getSettings();
  ui.serverUrl.value = settings.serverUrl;
  ui.serverToken.value = settings.serverToken;
  ui.trustedHosts.value = (settings.trustedHosts || []).join(", ");
  ui.quality.value = String(settings.quality);
  ui.folder.value = settings.downloadFolder || "";
  ui.template.value = settings.filenameTemplate || DEFAULTS.filenameTemplate;
  ui.askSave.checked = Boolean(settings.askWhereToSave);
  ui.notify.checked = Boolean(settings.notifyOnFinish);
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
    quality: ui.quality.value,
    downloadFolder: ui.folder.value.trim(),
    filenameTemplate: ui.template.value.trim() || DEFAULTS.filenameTemplate,
    askWhereToSave: ui.askSave.checked,
    notifyOnFinish: ui.notify.checked,
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
    showStatus(`Connected${version}${tools}`, "ok");
  } else {
    showStatus(res?.error || "Could not reach the server", "err");
  }
}

// Save on change so a forgotten "Save" click can never lose a setting.
for (const field of [ui.serverUrl, ui.serverToken, ui.trustedHosts, ui.quality, ui.folder, ui.template]) {
  field.addEventListener("change", save);
}
ui.template.addEventListener("input", updatePreview);
ui.folder.addEventListener("input", updatePreview);
for (const box of [ui.askSave, ui.notify]) {
  box.addEventListener("change", save);
}
el("test").addEventListener("click", test);
el("save").addEventListener("click", save);

load();

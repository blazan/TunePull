// Mock chrome.* so the real options page can run outside the extension.
// The one-click flow lives in the service worker and the toolbar badge, which a
// plain page cannot host, so the demo page recreates that part by hand.
const params = new URLSearchParams(location.search);
const SERVER = params.get("server") || "http://192.168.1.50:8756";

const settings = {
  serverUrl: SERVER,
  serverToken: "demo-token",
  trustedHosts: ["192.168.1.50"],
  mediaType: "audio",
  quality: "320",
  downloadFolder: "Music/YouTube",
  filenameTemplate: "{artist} - {title}",
  videoQuality: "1080",
  videoFolder: "Videos/YouTube",
  videoFilenameTemplate: "{artist} - {title}",
  askWhereToSave: false,
  notifyOnFinish: true,
  syncCookies: false,
};

function reply(cb, obj, delay = 40) {
  if (typeof cb === "function") setTimeout(() => cb(obj), delay);
  return Promise.resolve(obj);
}

window.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    openOptionsPage: () => {},
    getURL: (path) => path,
    sendMessage: (msg, cb) => {
      if (msg?.type === "tunepull:ping") {
        return reply(cb, {
          ok: true,
          data: {
            version: "1.3.0",
            tools: ["yt-dlp", "ffmpeg"],
            authRequired: true,
            cookies: false,
          },
        });
      }
      if (msg?.type === "tunepull:syncCookies") {
        return reply(cb, { ok: true, data: { ok: true, cookies: true, count: 6 } });
      }
      if (msg?.type === "tunepull:clearCookies") {
        return reply(cb, { ok: true, data: { ok: true, cookies: false, count: 0 } });
      }
      return reply(cb, { ok: false, error: "unhandled " + msg?.type });
    },
  },
  storage: {
    sync: {
      get: (defaults, cb) => reply(cb, { ...defaults, ...settings }, 30),
      set: (patch, cb) => {
        Object.assign(settings, patch);
        return reply(cb, undefined, 20);
      },
    },
  },
  notifications: { create: () => Promise.resolve("id") },
  downloads: { onChanged: { addListener: () => {} }, download: async () => 1 },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  commands: { onCommand: { addListener: () => {} } },
  tabs: { query: async () => [{ id: 1, url: "https://music.youtube.com/watch?v=fJ9rUzIMcZQ" }] },
  scripting: { executeScript: async () => [] },
};

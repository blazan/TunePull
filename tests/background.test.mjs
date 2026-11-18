/**
 * Drives the real service worker against mocked chrome.* + fetch.
 *
 *   node --test "tests/*.test.mjs"
 *
 * This exercises the one-click flow end to end (track -> job -> poll -> save)
 * without a browser or a helper server.
 */

import test from "node:test";
import assert from "node:assert/strict";

const SETTINGS = {
  serverUrl: "http://127.0.0.1:8756",
  serverToken: "tok",
  trustedHosts: [],
  quality: "320",
  downloadFolder: "Music/YouTube",
  filenameTemplate: "{artist} - {title}",
  askWhereToSave: false,
  notifyOnFinish: true,
};

const TRACK = {
  title: "Bohemian Rhapsody",
  artist: "Queen",
  album: "A Night at the Opera",
  videoId: "fJ9rUzIMcZQ",
  pageUrl: "https://music.youtube.com/watch?v=fJ9rUzIMcZQ",
};

/** Install a fresh set of mocks and import background.js. */
async function loadWorker({
  statuses,
  track = TRACK,
  settings = SETTINGS,
  downloadOutcome = "complete",
  downloadDelayMs = 0,
}) {
  const calls = {
    downloads: [],
    notifications: [],
    badges: [],
    requests: [],
  };

  let actionHandler = null;
  let jobCounter = 0;
  const statusQueue = [...statuses];
  // chrome.downloads.onChanged listeners, so the mock can report completion.
  const downloadListeners = new Set();

  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => {} },
    },
    action: {
      setBadgeText: async ({ text }) => calls.badges.push(text),
      setBadgeBackgroundColor: async () => {},
      onClicked: { addListener: (fn) => (actionHandler = fn) },
    },
    commands: { onCommand: { addListener: () => {} } },
    downloads: {
      download: async (opts) => {
        calls.downloads.push(opts);
        const id = 7;
        // Real Chrome reports the terminal state later, via onChanged — after the
        // worker has had a chance to subscribe. A timer (not a microtask) mirrors that.
        setTimeout(() => {
          const delta =
            downloadOutcome === "complete"
              ? { id, state: { current: "complete" } }
              : { id, state: { current: "interrupted" }, error: { current: downloadOutcome } };
          for (const listener of downloadListeners) listener(delta);
        }, downloadDelayMs);
        return id;
      },
      onChanged: {
        addListener: (fn) => downloadListeners.add(fn),
        removeListener: (fn) => downloadListeners.delete(fn),
      },
    },
    notifications: {
      create: async (opts) => calls.notifications.push(opts),
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://music.youtube.com/watch?v=x" }],
      sendMessage: async () => ({ ok: true, track }),
    },
    scripting: { executeScript: async () => [] },
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...settings }) } },
  };

  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    calls.requests.push({ href, method: opts.method || "GET" });
    if (href.includes("/download")) {
      jobCounter += 1;
      return { ok: true, status: 200, json: async () => ({ jobId: `job${jobCounter}` }) };
    }
    if (href.includes("/job/")) {
      const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      return { ok: true, status: 200, json: async () => next };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Cache-bust so each test gets a fresh module instance and fresh listeners.
  const mod = await import(`../extension/background.js?t=${Math.random()}`);
  assert.ok(actionHandler, "background.js must register chrome.action.onClicked");
  return { mod, calls, run: () => actionHandler(), getJobCount: () => jobCounter };
}

/** Let the fire-and-forget handleAction() promise chain settle. */
function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("one click downloads into the configured folder", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 40 },
      { state: "done", stage: "Ready", percent: 100, filename: "x.mp3" },
    ],
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 1, "exactly one download");
  const dl = calls.downloads[0];
  assert.equal(
    dl.filename,
    "Music/YouTube/Queen - Bohemian Rhapsody.mp3",
    "folder + templated name",
  );
  assert.equal(dl.saveAs, false, "no Save-as dialog unless configured");
  assert.match(dl.url, /\/file\/job1\?token=tok$/, "token passed as a query param");
});

test("progress is shown on the badge and a notification fires on success", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 40 },
      { state: "done", stage: "Ready", percent: 100 },
    ],
  });

  await run();
  await settle();

  assert.ok(calls.badges.includes("40%"), `expected 40% badge, got ${calls.badges}`);
  assert.ok(calls.badges.includes("✓"), `expected a success badge, got ${calls.badges}`);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Saved");
  assert.match(calls.notifications[0].message, /Music\/YouTube\/Queen - Bohemian Rhapsody\.mp3/);
});

test("a server-side error surfaces yt-dlp's message and no file is saved", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 60 },
      { state: "error", stage: "Failed", error: "HTTP Error 403: Forbidden" },
    ],
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0, "nothing saved on failure");
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Download failed");
  assert.match(calls.notifications[0].message, /403: Forbidden/);
  assert.ok(calls.badges.includes("!"), `expected a failure badge, got ${calls.badges}`);
});

test("askWhereToSave is honoured", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    settings: { ...SETTINGS, askWhereToSave: true, downloadFolder: "" },
  });

  await run();
  await settle();

  assert.equal(calls.downloads[0].saveAs, true);
  assert.equal(calls.downloads[0].filename, "Queen - Bohemian Rhapsody.mp3", "no folder prefix");
});

test("an untrusted server host is refused before any request is made", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", percent: 100 }],
    settings: { ...SETTINGS, serverUrl: "http://evil.example.com:8756", trustedHosts: [] },
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.requests.length, 0, "no request may leave for an untrusted host");
  assert.match(calls.notifications[0].message, /evil\.example\.com/);
});

test("no song on the page produces a helpful notification, not a crash", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", percent: 100 }],
    track: { title: "" },
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].message, /current track/i);
});

test("a repeated click for the same song does not start a second job", async () => {
  const { calls, run, getJobCount } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 10 },
      { state: "done", stage: "Ready", percent: 100 },
    ],
  });

  // Two clicks in the same instant, before the first job has started.
  await Promise.all([run(), run()]);
  await settle();

  assert.equal(getJobCount(), 1, "only one /download POST");
  assert.equal(calls.downloads.length, 1);
});

test("an interrupted transfer is reported as a failure, not a success", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    downloadOutcome: "NETWORK_FAILED",
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 1, "the download was attempted");
  assert.equal(calls.notifications.length, 1, "exactly one notification");
  assert.equal(calls.notifications[0].title, "Download failed");
  assert.match(calls.notifications[0].message, /connection dropped/i);
  assert.ok(calls.badges.includes("!"), `expected a failure badge, got ${calls.badges}`);
  assert.ok(!calls.badges.includes("✓"), "must not claim success");
});

test("cancelling the Save-as dialog is silent, not an error", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    settings: { ...SETTINGS, askWhereToSave: true },
    downloadOutcome: "USER_CANCELED",
  });

  await run();
  await settle();

  assert.equal(calls.notifications.length, 0, "no notification when the user cancels");
  assert.ok(!calls.badges.includes("!"), `no failure badge, got ${calls.badges}`);
});

test("success is announced only after Chrome reports completion", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    downloadOutcome: "complete",
    downloadDelayMs: 400,
  });

  // Do not await: we want to observe the state *before* the download completes.
  const pending = run();
  // The job is polled every 700ms, so wait past the first tick for the transfer to start.
  await settle(1000);
  assert.equal(calls.downloads.length, 1, "the transfer started");
  assert.equal(calls.notifications.length, 0, "no premature 'Saved' notification");

  await pending;
  await settle();
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Saved");
});
